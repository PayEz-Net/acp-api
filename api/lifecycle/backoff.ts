const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 60_000;
const MAX_CONSECUTIVE_CRASHES = 5;
const STABILITY_RESET_MS = 5 * 60 * 1000; // 5 minutes

export type AgentLifecycleStatus = 'spawning' | 'ready' | 'busy' | 'idle' | 'stopped' | 'error' | 'failed' | 'unknown';

export interface AgentState {
  name: string;
  status: AgentLifecycleStatus;
  terminalId: string | null;
  sessionId: string | null;
  workDir: string | null;
  /** Project the agent was spawned under — the LOOKUP KEY (not the effort
   *  value) for re-resolving effort_override FRESH from the DB at respawn
   *  (#16b). Caching the stable routing key is fine; caching the effort
   *  VALUE would drift if the user edits it mid-crash-window (Aurum 1421
   *  mini-hydra). null = caller didn't send projectId -> restart can't
   *  look up -> defers to the global resolver (documented micro-gap). */
  projectId: number | null;
  /** Runtime/provider the agent was spawned with. Used server-side to tag
   *  terminal output events; the desktop client value is only a fallback. */
  provider: string | null;
  autoReport: boolean;
  consecutiveCrashes: number;
  restartCount: number;
  lastExitCode: number | null;
  lastSpawnedAt: number | null;
  lastExitAt: number | null;
  stabilityTimer: ReturnType<typeof setTimeout> | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Crash-loop backoff manager.
 * Tracks consecutive crashes per agent and computes restart delay.
 */
export class BackoffManager {
  private agents = new Map<string, AgentState>();

  getOrCreate(name: string): AgentState {
    let state = this.agents.get(name);
    if (!state) {
      state = {
        name,
        status: 'stopped',
        terminalId: null,
        sessionId: null,
        workDir: null,
        projectId: null,
        provider: null,
        autoReport: true,
        consecutiveCrashes: 0,
        restartCount: 0,
        lastExitCode: null,
        lastSpawnedAt: null,
        lastExitAt: null,
        stabilityTimer: null,
        restartTimer: null,
      };
      this.agents.set(name, state);
    }
    return state;
  }

  get(name: string): AgentState | undefined {
    return this.agents.get(name);
  }

  getAll(): AgentState[] {
    return Array.from(this.agents.values());
  }

  /**
   * Called when an agent is spawned successfully.
   * Starts the stability timer — resets crash counter after 5 minutes.
   */
  markSpawned(name: string, terminalId: string, sessionId: string, provider?: string | null): void {
    const state = this.getOrCreate(name);
    state.status = 'ready';
    state.terminalId = terminalId;
    state.sessionId = sessionId;
    if (provider !== undefined) state.provider = provider ?? null;
    state.lastSpawnedAt = Date.now();
    state.lastExitCode = null;

    // Start stability timer
    if (state.stabilityTimer) clearTimeout(state.stabilityTimer);
    state.stabilityTimer = setTimeout(() => {
      state.consecutiveCrashes = 0;
    }, STABILITY_RESET_MS);
  }

  /**
   * Called when an agent exits. Returns whether auto-restart should happen.
   */
  markExited(name: string, exitCode: number): { shouldRestart: boolean; delay: number } {
    const state = this.getOrCreate(name);
    state.lastExitCode = exitCode;
    state.lastExitAt = Date.now();
    state.terminalId = null;

    // Clear stability timer
    if (state.stabilityTimer) {
      clearTimeout(state.stabilityTimer);
      state.stabilityTimer = null;
    }

    // Intentional stop: the kill/stop route sets status='stopped' BEFORE
    // tearing down the PTY. On Windows a user-initiated kill exits non-zero
    // (STATUS_CONTROL_C_EXIT = -1073741510), which the exitCode-only logic
    // below would misclassify as a crash and auto-restart — the "stop then
    // it respawns" bug. Honor the recorded intent: never resurrect an agent
    // the user explicitly stopped. A genuine crash leaves status at
    // 'ready'/'busy'/'idle', so this guard only catches deliberate stops.
    if (state.status === 'stopped') {
      return { shouldRestart: false, delay: 0 };
    }

    // Clean exit
    if (exitCode === 0) {
      state.status = 'stopped';
      return { shouldRestart: false, delay: 0 };
    }

    // Crash
    state.consecutiveCrashes++;
    state.restartCount++;

    if (state.consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
      state.status = 'failed';
      console.error(`[Lifecycle] ${name}: failed after ${MAX_CONSECUTIVE_CRASHES} consecutive crashes`);
      return { shouldRestart: false, delay: 0 };
    }

    state.status = 'error';
    const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, state.consecutiveCrashes - 1), BACKOFF_MAX_MS);
    return { shouldRestart: true, delay };
  }

  /**
   * Manual restart — resets failed state, bypasses backoff.
   */
  markManualRestart(name: string): void {
    const state = this.getOrCreate(name);
    state.status = 'spawning';
    // Don't reset consecutiveCrashes here — stability timer handles that
    if (state.restartTimer) {
      clearTimeout(state.restartTimer);
      state.restartTimer = null;
    }
  }

  /**
   * Mark all agents as unknown (e.g., when callback server is unreachable).
   */
  markAllUnknown(): void {
    for (const state of this.agents.values()) {
      if (state.status === 'ready' || state.status === 'busy' || state.status === 'idle') {
        state.status = 'unknown';
      }
    }
  }

  /**
   * Get serializable status for an agent.
   */
  getStatus(name: string): Record<string, unknown> | null {
    const state = this.agents.get(name);
    if (!state) return null;
    return {
      name: state.name,
      status: state.status,
      terminal_id: state.terminalId,
      session_id: state.sessionId,
      uptime_seconds: state.lastSpawnedAt && state.status === 'ready'
        ? Math.floor((Date.now() - state.lastSpawnedAt) / 1000)
        : null,
      restart_count: state.restartCount,
      consecutive_crashes: state.consecutiveCrashes,
      last_exit_code: state.lastExitCode,
    };
  }

  shutdown(): void {
    for (const state of this.agents.values()) {
      if (state.stabilityTimer) clearTimeout(state.stabilityTimer);
      if (state.restartTimer) clearTimeout(state.restartTimer);
    }
  }
}
