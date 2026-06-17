import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LocalEventBus } from '../sse/localEventBus.js';
import { ProcessMonitor } from './processMonitor.js';
import { resolveCliPath, cliMissingEnvelope } from './cliResolver.js';
import { safeChildEnv } from './safeChildEnv.js';

/**
 * Thrown when a pre-spawn CLI discovery (AC-1) fails. Caller should catch
 * this, surface `onboarding.cli_missing` to the user, and NOT persist any
 * contract/team state.
 */
export class CliMissingError extends Error {
  readonly code = 'onboarding.cli_missing';
  readonly expected_cmd: string;
  readonly install_url: string;
  constructor(expected_cmd: string, install_url: string) {
    super(`CLI not on PATH: ${expected_cmd}`);
    this.name = 'CliMissingError';
    this.expected_cmd = expected_cmd;
    this.install_url = install_url;
  }
}

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_QUEUE_TIMEOUT_MIN = 30;

interface SpawnRequest {
  contractId: number;
  agentName: string;
  hiredByName: string;
  assignment: string;
  conversationId: string;
  profilePath: string | null;
}

/**
 * Manages contractor session lifecycle: spawning, queuing, and queue draining.
 */
export class SessionManager {
  private storage: any;
  private eventBus: LocalEventBus;
  private cfg: any;
  private processMonitor: ProcessMonitor;
  private maxConcurrent: number;
  private contractorCmd: string;
  private queueTimeoutMin: number;

  private queueCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(storage: any, eventBus: LocalEventBus, cfg: any) {
    this.storage = storage;
    this.eventBus = eventBus;
    this.cfg = cfg;
    this.maxConcurrent = parseInt(process.env.ACP_MAX_CONTRACTORS || String(DEFAULT_MAX_CONCURRENT), 10);
    this.contractorCmd = process.env.ACP_CONTRACTOR_CMD || 'claude';
    this.queueTimeoutMin = parseInt(process.env.ACP_QUEUE_TIMEOUT_MINUTES || String(DEFAULT_QUEUE_TIMEOUT_MIN), 10);
    this.processMonitor = new ProcessMonitor(storage, eventBus, cfg, () => this.drainQueue());

    // F-2 fix: periodic queue drain + timeout check (every 60s)
    this.queueCheckInterval = setInterval(() => {
      this.drainQueue().catch(() => {});
    }, 60_000);
  }

  /** Expose process monitor for output/kill/status queries. */
  get monitor(): ProcessMonitor {
    return this.processMonitor;
  }

  /**
   * Called after a contract is created and mail is sent.
   * Decides whether to spawn immediately or queue.
   */
  async trySpawnOrQueue(request: SpawnRequest): Promise<'spawned' | 'queued'> {
    // Check limits: global concurrent + per-contractor
    const canSpawn =
      this.processMonitor.activeCount < this.maxConcurrent &&
      !this.processMonitor.hasRunningSession(request.agentName);

    if (canSpawn) {
      await this.spawnSession(request);
      return 'spawned';
    } else {
      // Queue: update contract status to 'queued'
      await this.storage._query(
        `UPDATE agent_contracts SET status = 'queued'
         WHERE id = ${request.contractId} AND status = 'active'`
      );

      // Calculate queue position
      const posResult = await this.storage._query(
        `SELECT COUNT(*) AS pos FROM agent_contracts WHERE status = 'queued'`
      );
      const position = parseInt(posResult.rows[0]?.pos || '1', 10);

      this.eventBus.emit({
        event: 'contractor-queued',
        data: {
          contract_id: request.contractId,
          agent_name: request.agentName,
          position,
        },
      });

      return 'queued';
    }
  }

  /**
   * Spawn a Claude CLI session for a contract.
   */
  private async spawnSession(request: SpawnRequest): Promise<void> {
    const { contractId, agentName, hiredByName, assignment, conversationId, profilePath } = request;

    // Create isolated temp workspace
    const workDir = join(tmpdir(), `acp-contractor-${contractId}`);
    await mkdir(workDir, { recursive: true });

    // Read profile content if available
    let profileContent = '';
    if (profilePath) {
      try {
        profileContent = await readFile(profilePath, 'utf-8');
      } catch {
        profileContent = `You are contractor agent "${agentName}".`;
      }
    } else {
      profileContent = `You are contractor agent "${agentName}".`;
    }

    // Build task prompt
    const taskPrompt = `You are contractor agent "${agentName}", hired by ${hiredByName}.

Your task: ${assignment}

Do the work requested. Write your findings and results to stdout. When done, output a clear summary of what you did and found.`;

    // Spawn contractor CLI (cross-platform, no shell — DotNetPert F-3)
    // ACP_CONTRACTOR_CMD env override for test stubs (QAPert requirement)
    const isClaude = this.contractorCmd.includes('claude');
    const args = isClaude
      ? [
          '--print',
          '--dangerously-skip-permissions',
          '--system-prompt', profileContent,
          '--prompt', taskPrompt,
        ]
      : [
          '--print',
          '--prompt', `${profileContent}\n\n${taskPrompt}`,
        ];

    // AC-1 (BAPert msg 283): pre-spawn PATH check. If the vendor CLI is not
    // installed, fail loud before `spawn()` so the route handler can undo
    // any contract state and return `onboarding.cli_missing`. This defends
    // against the original failure mode where child.on('error') collapsed
    // ENOENT into a generic exit-1 after the DB row was already live.
    // Skippable in unit-test harnesses — set ACP_SKIP_CLI_CHECK=1.
    if (process.env.ACP_SKIP_CLI_CHECK !== '1') {
      const resolved = resolveCliPath(this.contractorCmd);
      if (!resolved) {
        const envelope = cliMissingEnvelope(this.contractorCmd);
        throw new CliMissingError(envelope.details.expected_cmd, envelope.details.install_url);
      }
    }

    // AC-2 (BAPert msg 283): narrow the subprocess env to an allowlist so a
    // `--verbose` vendor CLI cannot echo ACP_LOCAL_SECRET / VAULT_API_TOKEN
    // / VIBESQL_CONTAINER_SECRET into its stdout/stderr. `ACP_CONVERSATION_ID`
    // is still injected — the CLI-side contract is unchanged.
    const child = spawn(this.contractorCmd, args, {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: safeChildEnv({ ACP_CONVERSATION_ID: conversationId }),
      windowsHide: true,
    });

    const pid = child.pid || 0;
    const now = new Date().toISOString();

    // Update contract with session info
    await this.storage._query(
      `UPDATE agent_contracts
       SET session_pid = ${pid}, session_started_at = '${now}', status = 'active'
       WHERE id = ${contractId}`
    );

    // Register with process monitor for exit/output tracking
    this.processMonitor.register(contractId, agentName, hiredByName, assignment, conversationId, child);

    console.log(`[SessionManager] Spawned session for contract ${contractId} (${agentName}), PID: ${pid}`);
  }

  /**
   * Drain the queue: expire timed-out queued contracts, then spawn the oldest if capacity allows.
   * Called by ProcessMonitor when a slot frees up.
   */
  private async drainQueue(): Promise<void> {
    // Expire queued contracts past queue timeout (ACP_QUEUE_TIMEOUT_MINUTES)
    try {
      await this.storage._query(
        `UPDATE agent_contracts
         SET status = 'expired', completed_at = NOW(), cancel_reason = 'queue-timeout'
         WHERE status = 'queued'
           AND created_at + (${this.queueTimeoutMin} || ' minutes')::INTERVAL < NOW()`
      );
    } catch { /* non-fatal */ }

    // Find oldest queued contract
    const result = await this.storage._query(
      `SELECT c.id, c.contractor_agent_id, c.hired_by_agent_id, c.contract_subject,
              c.profile_source, c.conversation_id, a.name AS contractor_name, h.name AS hired_by_name
       FROM agent_contracts c
       JOIN agents a ON a.id = c.contractor_agent_id
       JOIN agents h ON h.id = c.hired_by_agent_id
       WHERE c.status = 'queued'
       ORDER BY c.created_at ASC LIMIT 1`
    );

    if (result.rows.length === 0) return;
    const row = result.rows[0];

    // Check if we can spawn (global limit + per-contractor)
    if (
      this.processMonitor.activeCount >= this.maxConcurrent ||
      this.processMonitor.hasRunningSession(row.contractor_name)
    ) {
      return; // Still at capacity
    }

    // AC-7 (BAPert msg 283): reattach recheck. If CLI was uninstalled since
    // the original spawn, fail with cli_missing instead of stale reattach.
    if (process.env.ACP_SKIP_CLI_CHECK !== '1') {
      const resolved = resolveCliPath(this.contractorCmd);
      if (!resolved) {
        const envelope = cliMissingEnvelope(this.contractorCmd);
        throw new CliMissingError(envelope.details.expected_cmd, envelope.details.install_url);
      }
    }

    // Spawn it
    await this.spawnSession({
      contractId: row.id,
      agentName: row.contractor_name,
      hiredByName: row.hired_by_name,
      assignment: row.contract_subject,
      conversationId: row.conversation_id || '',
      profilePath: row.profile_source || null,
    });
  }

  /**
   * Run orphan detection on startup.
   */
  async checkOrphans(): Promise<number> {
    return this.processMonitor.checkOrphans();
  }

  /** Current status for settings panel. */
  getStatus(): { active: number; queued: number; max: number } {
    return {
      active: this.processMonitor.activeCount,
      queued: 0, // Will be populated from DB if needed
      max: this.maxConcurrent,
    };
  }
}
