import type { Config } from '../../config.js';
import type { BackoffManager } from './backoff.js';

const CALLBACK_HEALTH_INTERVAL_MS = 30_000;
const MAX_CALLBACK_FAILURES = 3;

/**
 * Monitors Electron callback server health and receives PTY exit events.
 * Health-checks the callback port every 30s.
 * After 3 consecutive failures, marks all agents as unknown.
 */
export class HealthMonitor {
  private cfg: Config;
  private backoff: BackoffManager;
  private callbackPort: number;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private consecutiveCallbackFailures = 0;
  private onRestartRequest: (agentName: string, delay: number) => void;

  constructor(
    cfg: Config,
    backoff: BackoffManager,
    callbackPort: number,
    onRestartRequest: (agentName: string, delay: number) => void
  ) {
    this.cfg = cfg;
    this.backoff = backoff;
    this.callbackPort = callbackPort;
    this.onRestartRequest = onRestartRequest;
  }

  /**
   * Start periodic health checking of the Electron callback server.
   */
  start(): void {
    this.healthTimer = setInterval(() => this.checkCallbackHealth(), CALLBACK_HEALTH_INTERVAL_MS);
    console.log(`[HealthMonitor] Started, checking callback port ${this.callbackPort} every ${CALLBACK_HEALTH_INTERVAL_MS / 1000}s`);
  }

  stop(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /**
   * Handle a PTY exit event from Electron.
   * exitCode 0 = clean exit, != 0 = crash with auto-restart.
   */
  /**
   * @param reason Present when the desktop killed this PTY ON PURPOSE (kill,
   *   restart, project teardown). Absent = a genuine unexpected exit.
   */
  handlePtyExit(
    agentName: string,
    terminalId: string,
    exitCode: number,
    reason?: string,
  ): void {
    // A DELIBERATE kill is not a crash, and a tree-kill exits non-zero exactly
    // like one — so exit code alone cannot tell them apart. Without this, a
    // restart (kill, then spawn) had its kill counted as a crash: the scheduler
    // fired, the freshly-spawned pane was already up, and the attempt came back
    // 409. Observed as a QAPert restart loop on 2026-07-29.
    //
    // Also skips markExited deliberately: counting intentional restarts as
    // crashes burns the consecutive-crash budget and would eventually disable
    // auto-restart for an agent that never actually crashed. The follow-up
    // spawn (or teardown) is what sets the next state.
    if (reason) {
      console.log(
        `[HealthMonitor] ${agentName}: PTY exited intentionally (reason=${reason}, ` +
          `code=${exitCode}) — not a crash, no restart scheduled`,
      );
      return;
    }

    console.log(`[HealthMonitor] ${agentName}: PTY exited (code=${exitCode}, terminal=${terminalId})`);

    const { shouldRestart, delay } = this.backoff.markExited(agentName, exitCode);

    if (shouldRestart) {
      const state = this.backoff.get(agentName);
      console.log(`[HealthMonitor] ${agentName}: scheduling restart in ${delay}ms (crash ${state?.consecutiveCrashes}/${5})`);
      this.onRestartRequest(agentName, delay);
    } else if (exitCode !== 0) {
      console.error(`[HealthMonitor] ${agentName}: auto-restart disabled (failed state or max crashes)`);
    }
  }

  private async checkCallbackHealth(): Promise<void> {
    const url = `http://127.0.0.1:${this.callbackPort}/health`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.cfg.acpLocalSecret}` },
        signal: controller.signal,
      });

      if (res.ok) {
        if (this.consecutiveCallbackFailures > 0) {
          console.log(`[HealthMonitor] Callback server recovered after ${this.consecutiveCallbackFailures} failures`);
        }
        this.consecutiveCallbackFailures = 0;
      } else {
        this.handleCallbackFailure(`HTTP ${res.status}`);
      }
    } catch (err: any) {
      const msg = err.name === 'AbortError' ? 'timeout' : err.message;
      this.handleCallbackFailure(msg);
    } finally {
      clearTimeout(timeout);
    }
  }

  private handleCallbackFailure(reason: string): void {
    this.consecutiveCallbackFailures++;
    console.warn(`[HealthMonitor] Callback server unreachable (${this.consecutiveCallbackFailures}/${MAX_CALLBACK_FAILURES}): ${reason}`);

    if (this.consecutiveCallbackFailures >= MAX_CALLBACK_FAILURES) {
      console.error(`[HealthMonitor] Callback server down — marking all agents as unknown`);
      this.backoff.markAllUnknown();
    }
  }
}
