import { type ChildProcess } from 'node:child_process';
import { execSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LocalEventBus } from '../sse/localEventBus.js';
import { signVibeRequest } from '../auth/vibeHmac.js';
import { scrubOutput, buildDefaultScrubContext } from './outputScrubber.js';

const RING_BUFFER_SIZE = 100;
const SSE_THROTTLE_MS = 1000;

interface TrackedProcess {
  contractId: number;
  agentName: string;
  hiredByName: string;
  assignment: string;
  conversationId: string;
  child: ChildProcess;
  outputLines: string[];
  lastSseEmit: number;
  startedAt: number; // F-6 fix: capture spawn time, not Node internals
}

/**
 * Tracks spawned contractor processes, captures output, handles exit/orphan detection.
 */
export class ProcessMonitor {
  private processes = new Map<number, TrackedProcess>();
  private completedOutputs = new Map<number, { lines: string[]; truncated: boolean }>(); // F-3 fix
  private storage: any;
  private eventBus: LocalEventBus;
  private onSlotFreed: () => void;
  private cfg: any;

  constructor(storage: any, eventBus: LocalEventBus, cfg: any, onSlotFreed: () => void) {
    this.storage = storage;
    this.eventBus = eventBus;
    this.cfg = cfg;
    this.onSlotFreed = onSlotFreed;
  }

  /**
   * Register a spawned process for monitoring.
   * Wires up stdout/stderr capture, exit handler, and SSE events.
   */
  register(
    contractId: number,
    agentName: string,
    hiredByName: string,
    assignment: string,
    conversationId: string,
    child: ChildProcess,
  ): void {
    const tracked: TrackedProcess = {
      contractId,
      agentName,
      hiredByName,
      assignment,
      conversationId,
      child,
      outputLines: [],
      lastSseEmit: 0,
      startedAt: Date.now(),
    };

    this.processes.set(contractId, tracked);

    // Emit session-started
    this.eventBus.emit({
      event: 'session-started',
      data: { contract_id: contractId, agent_name: agentName, pid: child.pid },
    });

    // Capture stdout
    child.stdout?.on('data', (chunk: Buffer) => {
      this.appendOutput(tracked, chunk.toString(), 'stdout');
    });

    // Capture stderr
    child.stderr?.on('data', (chunk: Buffer) => {
      this.appendOutput(tracked, chunk.toString(), 'stderr');
    });

    // Handle exit
    child.on('exit', (code: number | null) => {
      this.handleExit(tracked, code ?? 1);
    });

    // Handle error (spawn failure)
    child.on('error', (err: Error) => {
      console.error(`[ProcessMonitor] Spawn error for contract ${contractId}:`, err.message);
      this.handleExit(tracked, 1);
    });
  }

  private appendOutput(tracked: TrackedProcess, text: string, stream: 'stdout' | 'stderr'): void {
    const lines = text.split('\n').filter(l => l.length > 0);
    for (const rawLine of lines) {
      // AC-2 (BAPert msg 283): scrub secrets and home paths from captured
      // output before it reaches SSE, DB, or logs. Fail-open: if scrubber
      // throws, log and push raw line. Liveness > exactness.
      let line = rawLine;
      try {
        line = scrubOutput(rawLine, buildDefaultScrubContext());
      } catch (err) {
        console.error('[ProcessMonitor] scrubOutput failed:', err);
      }
      tracked.outputLines.push(line);
      // Ring buffer: trim to max size
      if (tracked.outputLines.length > RING_BUFFER_SIZE) {
        tracked.outputLines.shift();
      }
    }

    // Throttled SSE emit
    const now = Date.now();
    if (now - tracked.lastSseEmit >= SSE_THROTTLE_MS) {
      tracked.lastSseEmit = now;
      this.eventBus.emit({
        event: 'session-output',
        data: {
          contract_id: tracked.contractId,
          line: lines[lines.length - 1] || '',
          stream,
        },
      });
    }
  }

  private async handleExit(tracked: TrackedProcess, code: number): Promise<void> {
    const now = new Date().toISOString();
    const durationMs = Date.now() - tracked.startedAt; // F-6 fix

    // Update DB
    try {
      await this.storage._query(
        `UPDATE agent_contracts
         SET exit_code = ${code},
             session_ended_at = '${now}',
             status = ${code === 0 ? "'completed'" : "'expired'"},
             completed_at = '${now}'
         WHERE id = ${tracked.contractId} AND status = 'active'`
      );
    } catch (err) {
      console.error(`[ProcessMonitor] Failed to update contract ${tracked.contractId}:`, err);
    }

    // On clean exit: send DONE reply on behalf of contractor
    if (code === 0) {
      await this.sendDoneReply(tracked);
      this.eventBus.emit({
        event: 'contractor-completed',
        data: { contract_id: tracked.contractId, contractor_agent_id: null },
      });
    } else {
      this.eventBus.emit({
        event: 'contractor-expired',
        data: { contract_id: tracked.contractId, exit_code: code },
      });
    }

    // Emit session-exited SSE
    this.eventBus.emit({
      event: 'session-exited',
      data: {
        contract_id: tracked.contractId,
        agent_name: tracked.agentName,
        exit_code: code,
        duration_seconds: Math.round(durationMs / 1000),
      },
    });

    // F-3 fix: preserve output buffer after exit (persists until ACP restart)
    this.completedOutputs.set(tracked.contractId, {
      lines: [...tracked.outputLines],
      truncated: tracked.outputLines.length >= RING_BUFFER_SIZE,
    });

    // Cleanup running process entry
    this.processes.delete(tracked.contractId);

    // F-4 fix: clean up temp workspace
    try {
      const workDir = join(tmpdir(), `acp-contractor-${tracked.contractId}`);
      await rm(workDir, { recursive: true, force: true });
    } catch { /* non-fatal */ }

    // Notify session manager to drain queue
    this.onSlotFreed();
  }

  /**
   * Send DONE: reply to chat conversation. Mail DONE only if contractor has a mailbox slot. (AC-16)
   * F-1 fix: query contract at exit time to get current mailbox_slot (not from TrackedProcess).
   */
  private async sendDoneReply(tracked: TrackedProcess): Promise<void> {
    const last50 = tracked.outputLines.slice(-50).join('\n');

    // Primary: POST DONE to chat conversation
    if (tracked.conversationId) {
      try {
        const url = `http://localhost:${this.cfg.port}/v1/chat/conversations/${tracked.conversationId}/messages`;
        await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-ACP-Agent': tracked.agentName,
          },
          body: JSON.stringify({
            text: `DONE: ${tracked.assignment}\n\n${last50 || '(no output captured)'}`,
            flags: ['fyi'],
          }),
        });
      } catch (err) {
        console.error(`[ProcessMonitor] Failed to send DONE to chat for contract ${tracked.contractId}:`, err);
      }
    }

    // Secondary: send via cloud mail only if mailbox slot is assigned
    // Query the contract to get current mailbox_slot (may have been assigned after spawn)
    try {
      const result = await this.storage._query(
        `SELECT mailbox_slot FROM agent_contracts WHERE id = ${tracked.contractId}`
      );
      const mailboxSlot = result.rows?.[0]?.mailbox_slot;
      if (mailboxSlot) {
        const path = '/v1/agentmail/send';
        const url = `${this.cfg.vibeApiUrl}${path}`;
        const hmac = signVibeRequest('POST', path, {
          clientId: this.cfg.vibeClientId,
          signingKey: this.cfg.vibeHmacKey,
        });
        await fetch(url, {
          method: 'POST',
          headers: {
            ...hmac,
            'X-Vibe-Via': 'idp-proxy',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from_agent: mailboxSlot,
            to: [tracked.hiredByName],
            subject: `DONE: ${tracked.assignment}`,
            body: last50 || '(no output captured)',
          }),
        });
      }
    } catch { /* non-fatal — chat is primary */ }
  }

  /**
   * Get output ring buffer for a contract.
   * F-3 fix: checks completed outputs if process is no longer running.
   */
  getOutput(contractId: number): { lines: string[]; truncated: boolean } {
    const tracked = this.processes.get(contractId);
    if (tracked) {
      return {
        lines: [...tracked.outputLines],
        truncated: tracked.outputLines.length >= RING_BUFFER_SIZE,
      };
    }
    // Check completed outputs (persisted until ACP restart)
    return this.completedOutputs.get(contractId) || { lines: [], truncated: false };
  }

  /**
   * Kill a running session (for cancel). Immediate on Windows.
   */
  killSession(contractId: number): boolean {
    const tracked = this.processes.get(contractId);
    if (!tracked) return false;
    try {
      tracked.child.kill();
      return true;
    } catch {
      return false;
    }
  }

  /** Number of currently running processes. */
  get activeCount(): number {
    return this.processes.size;
  }

  /** Check if a specific contractor agent already has a running session. */
  hasRunningSession(agentName: string): boolean {
    for (const tracked of this.processes.values()) {
      if (tracked.agentName === agentName) return true;
    }
    return false;
  }

  /**
   * Orphan detection on startup. Checks DB for active contracts with session_pid set
   * and verifies the PID still exists. Marks orphans as expired.
   */
  async checkOrphans(): Promise<number> {
    let count = 0;
    try {
      const result = await this.storage._query(
        `SELECT id, session_pid FROM agent_contracts
         WHERE status = 'active' AND session_pid IS NOT NULL`
      );
      for (const row of result.rows) {
        const pid = row.session_pid;
        if (!this.isPidAlive(pid)) {
          await this.storage._query(
            `UPDATE agent_contracts
             SET status = 'expired', completed_at = NOW(),
                 session_ended_at = NOW(), cancel_reason = 'acp-restart'
             WHERE id = ${row.id}`
          );
          count++;
        }
      }
    } catch (err) {
      console.error('[ProcessMonitor] Orphan check failed:', err);
    }
    return count;
  }

  /**
   * Check if a PID is alive. On Windows, uses tasklist with PID filter
   * and verifies process name contains 'kimi' (QAPert F-8: PID reuse).
   */
  private isPidAlive(pid: number): boolean {
    try {
      if (process.platform === 'win32') {
        const output = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf-8', timeout: 3000 });
        return output.toLowerCase().includes('claude');
      } else {
        process.kill(pid, 0);
        return true;
      }
    } catch {
      return false;
    }
  }
}
