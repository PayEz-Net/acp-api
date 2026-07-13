/**
 * Terminal output bridge.
 *
 * Receives raw PTY byte chunks from acp-desktop, normalizes them into plain
 * text lines, scrubs secrets/home paths, throttles per-agent output, and emits
 * structured `agent-output` SSE events so the renderer can render a unified,
 * chat-style overview of what every agent is doing right now.
 *
 * Normalization:
 *   - Strip ANSI escape sequences.
 *   - Collapse \r\n and standalone \r to \n.
 *   - Discard empty lines (whitespace-only lines are kept so intentional
 *     blank lines in tool output remain visible).
 *   - Scrub via outputScrubber (ACP secrets + provider keys + user home path).
 *
 * Throttling:
 *   - Per-agent token bucket: burst capacity 25, refill 10 tokens/sec.
 *   - Lines beyond the bucket are dropped (counted, logged), never queued.
 *
 * Buffering: PTY chunks frequently split lines mid-byte, so we buffer per
 * terminal and emit only complete lines. The trailing partial line is flushed
 * when the next chunk completes it or when the terminal exits.
 */

import { scrubOutput, buildDefaultScrubContext } from '../contractors/outputScrubber.js';
import type { LocalEventBus } from '../sse/localEventBus.js';
import type { AgentOutputStore, StoredAgentOutputLine } from './agentOutputStore.js';

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
const CRLF_RE = /\r\n/g;
const CR_RE = /\r/g;
const STALE_BUFFER_MS = 30_000;

// Per-agent token-bucket throttling (DoD #16-20, #45).
const THROTTLE_CAPACITY = 25; // burst
const THROTTLE_REFILL_PER_SEC = 10;

export interface AgentOutputLine {
  agent: string;
  terminal_id: string;
  provider?: string;
  line: string;
  ts: string;
  /** Internal routing field, stripped before SSE wire. */
  project_id?: string;
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

export class TerminalOutputBridge {
  private bus: LocalEventBus;
  private store: AgentOutputStore | null;
  private buffers = new Map<string, string>();
  private lastActivity = new Map<string, number>();
  private scrubCtx = buildDefaultScrubContext();
  private flushTimer: NodeJS.Timeout | null = null;

  private buckets = new Map<string, TokenBucket>();
  private droppedLineCount = 0;
  private droppedByteCount = 0;
  private lastDropLog = Date.now();

  private invalidInputCount = 0;

  constructor(bus: LocalEventBus, store?: AgentOutputStore) {
    this.bus = bus;
    this.store = store || null;
  }

  /**
   * Record a malformed inbound payload. Exposed so the HTTP route can count
   * dropped requests without rendering them.
   */
  recordInvalidInput(): void {
    this.invalidInputCount++;
    if (this.invalidInputCount % 100 === 1) {
      console.warn(`[TerminalOutputBridge] ${this.invalidInputCount} malformed inbound payload(s) dropped`);
    }
  }

  getInvalidInputCount(): number {
    return this.invalidInputCount;
  }

  /**
   * Start a periodic flush of stale partial-line buffers. Any terminal whose
   * trailing partial line has not received new data in STALE_BUFFER_MS is
   * flushed as a complete line. Call stopPeriodicFlush on shutdown.
   */
  startPeriodicFlush(intervalMs = STALE_BUFFER_MS): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flushStaleBuffers(), intervalMs);
    // Prevent the timer from keeping the process alive (e.g., in tests).
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  stopPeriodicFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private flushStaleBuffers(): void {
    const now = Date.now();
    for (const [terminalId, ts] of this.lastActivity) {
      if (now - ts > STALE_BUFFER_MS) {
        this.flush(terminalId);
      }
    }
  }

  private getBucket(agentName: string): TokenBucket {
    let bucket = this.buckets.get(agentName);
    if (!bucket) {
      bucket = { tokens: THROTTLE_CAPACITY, lastRefill: Date.now() };
      this.buckets.set(agentName, bucket);
    }
    return bucket;
  }

  /**
   * Consume one token from the per-agent bucket. Returns true if the line is
   * allowed through. Refills tokens based on elapsed time.
   */
  private allowLine(agentName: string): boolean {
    const bucket = this.getBucket(agentName);
    const now = Date.now();
    const elapsedMs = now - bucket.lastRefill;
    if (elapsedMs > 0) {
      const refill = (elapsedMs / 1000) * THROTTLE_REFILL_PER_SEC;
      bucket.tokens = Math.min(THROTTLE_CAPACITY, bucket.tokens + refill);
      bucket.lastRefill = now;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  private recordDroppedLine(line: string): void {
    this.droppedLineCount++;
    this.droppedByteCount += Buffer.byteLength(line);
    const now = Date.now();
    if (now - this.lastDropLog > 30_000) {
      console.warn(`[TerminalOutputBridge] Dropped ${this.droppedLineCount} throttled line(s) (${this.droppedByteCount} bytes) in the last 30s`);
      this.droppedLineCount = 0;
      this.droppedByteCount = 0;
      this.lastDropLog = now;
    }
  }

  push(
    agentName: string,
    terminalId: string,
    raw: string,
    provider?: string,
    projectId?: string | null,
    sessionId?: string | null,
  ): void {
    if (!raw) return;

    let text = raw.replace(ANSI_RE, '').replace(CRLF_RE, '\n').replace(CR_RE, '\n');
    if (!text) return;

    try {
      text = scrubOutput(text, this.scrubCtx);
    } catch (err) {
      // Scrubbing is best-effort; never drop the stream because of a regex blow-up.
      console.warn(`[TerminalOutputBridge] Scrub failed for ${agentName}:`, err);
    }

    const endsWithNewline = text.endsWith('\n');
    let buf = (this.buffers.get(terminalId) || '') + text;
    this.lastActivity.set(terminalId, Date.now());
    const lines = buf.split('\n');
    const tail = endsWithNewline ? '' : lines.pop();
    this.buffers.set(terminalId, tail || '');

    for (const line of lines) {
      // Emit only non-empty lines. Whitespace-only lines are intentionally kept
      // because they can be meaningful spacing in tool output.
      if (line.length === 0) continue;

      // Throttle before emit/storage; dropped lines are silently counted.
      if (!this.allowLine(agentName)) {
        this.recordDroppedLine(line);
        continue;
      }

      const ts = new Date().toISOString();
      const payload: AgentOutputLine = {
        agent: agentName,
        terminal_id: terminalId,
        provider: provider || 'unknown',
        line,
        ts,
        ...(projectId ? { project_id: projectId } : {}),
      };
      this.bus.emitAgentOutput(payload as unknown as Record<string, unknown>);

      if (this.store && projectId) {
        try {
          const stored: StoredAgentOutputLine = {
            project_id: projectId,
            session_id: sessionId || 'unknown',
            agent: agentName,
            terminal_id: terminalId,
            provider: provider || 'unknown',
            line,
            ts,
          };
          this.store.write(stored);
        } catch (err) {
          // Storage failure must not break the live SSE stream.
          console.warn(`[TerminalOutputBridge] Storage write failed for ${agentName}:`, err);
        }
      }
    }
  }

  /** Flush any buffered partial line for a terminal (call on PTY exit). */
  flush(terminalId: string, agentName?: string, provider?: string, projectId?: string | null): void {
    const tail = this.buffers.get(terminalId);
    this.buffers.delete(terminalId);
    this.lastActivity.delete(terminalId);
    if (tail && tail.length > 0) {
      this.bus.emitAgentOutput({
        agent: agentName || 'unknown',
        terminal_id: terminalId,
        provider: provider || 'unknown',
        line: tail,
        ts: new Date().toISOString(),
        ...(projectId ? { project_id: projectId } : {}),
      } as unknown as Record<string, unknown>);
    }
  }

  /** Drop a terminal's buffer without emitting (call on terminal kill/reset). */
  drop(terminalId: string): void {
    this.buffers.delete(terminalId);
    this.lastActivity.delete(terminalId);
  }
}
