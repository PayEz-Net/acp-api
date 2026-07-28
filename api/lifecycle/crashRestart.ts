/**
 * Crash auto-restart scheduler (extracted from server.js so the
 * ENGAGEMENT_REQUIRED path is unit-testable — ACP-8, live-team merge).
 *
 * Behavior is identical to the former inline closure: on crash, wait `delay`
 * (the BackoffManager's backoff), bootstrap a fresh session, re-resolve the
 * member's effort / the team runtime / the member's model FRESH from the
 * cloud, then ask the Electron callback to respawn. ACP-3: an empty live
 * roster (no team engaged) aborts the respawn with status='error' — never a
 * default-spawn from a crash loop.
 */

import type { Config } from '../../config.js';
import type { BackoffManager } from './backoff.js';
import {
  resolveMemberEffort,
  resolveMemberModel,
  resolveTeamRuntime,
  ENGAGEMENT_REQUIRED,
} from '../routes/team.js';

export interface CrashRestartDeps {
  cfg: Config;
  backoff: BackoffManager;
  callbackPort: number;
  bootstrap: (agentName: string) => Promise<{ session: any }>;
}

export function makeCrashRestartScheduler(
  deps: CrashRestartDeps,
): (agentName: string, delay: number) => void {
  const { cfg, backoff, callbackPort, bootstrap } = deps;

  return (agentName: string, delay: number) => {
    const state = backoff.getOrCreate(agentName);
    state.restartTimer = setTimeout(async () => {
      try {
        const { session } = await bootstrap(agentName);
        // #16b: re-resolve effort FRESH from the DB at crash auto-restart
        // (Aurum 1421 — a cached value drifts if effort was edited during the
        // crash/backoff window; the drift test demands the CURRENT DB value).
        // Defers to the global resolver if no project ctx / no active session.
        const freshEffort = state.projectId != null
          ? await resolveMemberEffort(cfg, state.projectId, agentName)
          : undefined;
        // WO #84135 §3.1/§2.3 (sibling of the /restart route fix): re-resolve
        // the TEAM runtime FRESH too — symmetry with freshEffort. Without it
        // this crash auto-restart OMITTED runtime, so Electron fell to the
        // global agentProvider and a kimi team's crash-looped agent came back
        // claude. Omit when unresolved (no project ctx / no session / unset).
        const freshRuntime = state.projectId != null
          ? await resolveTeamRuntime(cfg, state.projectId)
          : undefined;
        // WO 11469 (b): re-resolve model_override FRESH as well — a restarted
        // kimi agent must keep its -m alias AND its k3 effort env.
        const freshModel = state.projectId != null
          ? await resolveMemberModel(cfg, state.projectId, agentName)
          : undefined;
        // ACP-3 (live-team merge): an empty live roster = NO team engaged on
        // the project. Do NOT default-spawn from a crash loop — surface the
        // ENGAGEMENT_REQUIRED state and stop; the user must engage a team.
        if (freshEffort === ENGAGEMENT_REQUIRED || freshModel === ENGAGEMENT_REQUIRED) {
          state.status = 'error';
          console.error(`[Lifecycle] ${agentName}: ENGAGEMENT_REQUIRED — no team engaged on project ${state.projectId}; crash auto-restart aborted (engage a team first)`);
          return;
        }
        const result = await fetch(`http://127.0.0.1:${callbackPort}/internal/pty/spawn`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${cfg.acpLocalSecret}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ agentName, workDir: state.workDir, autoReport: state.autoReport, ...(freshEffort ? { effort: freshEffort } : {}), ...(freshRuntime ? { runtime: freshRuntime } : {}), ...(freshModel ? { model: freshModel } : {}) }),
        });
        if (result.ok) {
          const data = await result.json();
          const terminalId = data?.terminalId || data?.data?.terminalId || '';
          state.provider = freshRuntime || null;
          backoff.markSpawned(agentName, terminalId, session.sessionId || '', state.provider);
          console.log(`[Lifecycle] ${agentName}: auto-restarted successfully`);
        } else {
          state.status = 'error';
          console.error(`[Lifecycle] ${agentName}: auto-restart failed (HTTP ${result.status})`);
        }
      } catch (err: any) {
        state.status = 'error';
        console.error(`[Lifecycle] ${agentName}: auto-restart failed: ${err.message}`);
      }
    }, delay);
  };
}
