import { Router, type Request, type Response } from 'express';
import { success, error } from '../response.js';
import type { BackoffManager } from '../lifecycle/backoff.js';
import type { HealthMonitor } from '../lifecycle/healthMonitor.js';
import type { Config } from '../../config.js';
import { resolveAgentId, resolveMemberEffort, resolveTeamRuntime } from './team.js';

interface LifecycleDeps {
  cfg: Config;
  backoff: BackoffManager;
  healthMonitor: HealthMonitor;
  callbackPort: number;
  bootstrap: (agentName: string) => Promise<{ session: any; source: string }>;
}

const CALLBACK_TIMEOUT_MS = 10_000;

async function callElectron(
  cfg: Config,
  callbackPort: number,
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; data: any }> {
  const url = `http://127.0.0.1:${callbackPort}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.acpLocalSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json();
    return { status: res.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

export default function agentLifecycleRoutes(deps: LifecycleDeps): Router {
  const { cfg, backoff, healthMonitor, callbackPort, bootstrap } = deps;
  const router = Router();

  // POST /v1/lifecycle/agents/:name/spawn
  router.post('/:name/spawn', async (req: Request, res: Response) => {
    const name = req.params.name as string;
    const { workDir, autoReport, runtime, effort, projectId } = req.body || {};

    // Project-driven runtime — renderer reads activeProject.runtime_choice
    // and POSTs it here. Forwarded as-is to the Electron callback server;
    // pty.ts validates + falls back to settings.agentProvider on unknown
    // values. Per feedback_runtime_choice_vs_platform_llm.
    const validRuntime = (runtime === 'claude' || runtime === 'kimi')
      ? runtime
      : undefined;

    // Per-agent effort override (Claude-only). The caller (renderer with
    // team context) POSTs the agent's effort_override; forward it to the
    // Electron callback so lifecycle-server -> spawnAgent's single resolver
    // (opts?.effort || settings.claudeEffort || 'high') honors it. Unknown/
    // absent -> undefined = defer to the global default (no second authority,
    // Aurum 1401/1411). Per-member, unlike the project-uniform runtime.
    const validEffort = (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'max')
      ? effort
      : undefined;

    try {
      const state = backoff.getOrCreate(name);
      state.status = 'spawning';
      state.workDir = workDir || null;
      // #16b: store the PROJECT (the lookup key) so restarts can re-resolve
      // effort_override FRESH from the DB — never a cached value (Aurum 1421:
      // a cached value drifts if the user edits effort mid-crash-window).
      state.projectId = typeof projectId === 'number' ? projectId : null;
      state.autoReport = autoReport !== false;

      // Bootstrap session
      const { session } = await bootstrap(name);

      // Resolve the canonical agent_id so the Electron side can start a
      // PayEzVibe agent_session for the stream endpoint.
      const agentId = typeof req.body?.agentId === 'number'
        ? req.body.agentId
        : (state.projectId != null ? await resolveAgentId(cfg, state.projectId, name) : undefined);

      // Call Electron to spawn PTY
      const result = await callElectron(cfg, callbackPort, '/internal/pty/spawn', {
        agentName: name,
        workDir: workDir || undefined,
        autoReport: state.autoReport,
        projectId: state.projectId ?? undefined,
        ...(agentId != null ? { agentId } : {}),
        ...(validRuntime ? { runtime: validRuntime } : {}),
        ...(validEffort ? { effort: validEffort } : {}),
      });

      // 409 = agent already running — reuse existing terminalId
      if (result.status === 409) {
        const existingId = result.data?.terminalId || result.data?.data?.terminalId || '';
        if (existingId) {
          backoff.markSpawned(name, existingId, session.sessionId || session.session?.sessionId || '', validRuntime);
          res.json(success({
            agent_name: name,
            terminal_id: existingId,
            session_id: state.sessionId,
            status: state.status,
            reattached: true,
          }, 'agent_spawn', (req as any).requestId));
          return;
        }
      }

      if (result.status !== 200) {
        state.status = 'error';
        // SPEC §3.3: relay a typed WORKDIR_INVALID from the Electron callback
        // VERBATIM (code + message + detail), never flatten to the bare status.
        // 422 = the project's working folder can't instantiate; the renderer
        // surfaces an actionable banner (§3.4) instead of an opaque 500.
        if (result.data?.code === 'WORKDIR_INVALID') {
          res.status(422).json(
            error('WORKDIR_INVALID', result.data.message, 'agent_spawn', (req as any).requestId, {
              agent_name: name,
              work_dir: result.data.work_dir,
            })
          );
          return;
        }
        res.status(result.status).json(
          error('SPAWN_FAILED', `Electron callback returned ${result.status}`, 'agent_spawn', (req as any).requestId)
        );
        return;
      }

      const terminalId = result.data?.terminalId || result.data?.data?.terminalId || '';
      backoff.markSpawned(name, terminalId, session.sessionId || session.session?.sessionId || '', validRuntime);

      res.json(success({
        agent_name: name,
        terminal_id: terminalId,
        session_id: state.sessionId,
        status: state.status,
      }, 'agent_spawn', (req as any).requestId));
    } catch (err: any) {
      const state = backoff.getOrCreate(name);
      state.status = 'error';
      const msg = err.name === 'AbortError' ? 'Electron callback timeout' : err.message;
      res.status(502).json(
        error('SPAWN_FAILED', `Spawn failed: ${msg}`, 'agent_spawn', (req as any).requestId)
      );
    }
  });

  // POST /v1/lifecycle/agents/:name/kill
  router.post('/:name/kill', async (req: Request, res: Response) => {
    const name = req.params.name as string;
    const state = backoff.get(name);

    if (!state || !state.terminalId) {
      res.status(404).json(
        error('AGENT_NOT_FOUND', `Agent ${name} is not running`, 'agent_kill', (req as any).requestId)
      );
      return;
    }

    try {
      const result = await callElectron(cfg, callbackPort, '/internal/pty/kill', {
        agentName: name,
        terminalId: state.terminalId,
      });

      state.status = 'stopped';
      state.terminalId = null;

      res.json(success({
        agent_name: name,
        status: 'stopped',
      }, 'agent_kill', (req as any).requestId));
    } catch (err: any) {
      const msg = err.name === 'AbortError' ? 'Electron callback timeout' : err.message;
      res.status(502).json(
        error('KILL_FAILED', `Kill failed: ${msg}`, 'agent_kill', (req as any).requestId)
      );
    }
  });

  // POST /v1/lifecycle/agents/:name/restart
  router.post('/:name/restart', async (req: Request, res: Response) => {
    const name = req.params.name as string;

    try {
      const state = backoff.getOrCreate(name);
      backoff.markManualRestart(name);

      // Kill if running
      if (state.terminalId) {
        try {
          await callElectron(cfg, callbackPort, '/internal/pty/kill', {
            agentName: name,
            terminalId: state.terminalId,
          });
        } catch {
          // Kill failure is non-fatal for restart
        }
        state.terminalId = null;
      }

      // Bootstrap session
      const { session } = await bootstrap(name);

      // #16b: re-resolve effort FRESH from the DB at respawn (Aurum 1421 —
      // a cached value drifts if the user edited effort during the window;
      // the drift test demands the CURRENT DB value). Defers to the global
      // resolver when there's no project ctx / no active session.
      const freshEffort = state.projectId != null
        ? await resolveMemberEffort(cfg, state.projectId, name)
        : undefined;
      // WO #84135 §3.1/§2.3: re-resolve the TEAM runtime FRESH from the project
      // record too — exact symmetry with freshEffort. Before this, restart
      // OMITTED runtime, so Electron's spawnAgent fell to settings.agentProvider
      // (global) and a kimi team's restarted agent came back claude (the
      // asymmetry-with-effort bug). Now restart carries the team runtime, so a
      // restarted agent always conforms to its team. Omit when unresolved
      // (no project ctx / no session / runtime_choice unset) — the global-mask
      // kill for the unset case is a separate slice (spec §9 step 5).
      const freshRuntime = state.projectId != null
        ? await resolveTeamRuntime(cfg, state.projectId)
        : undefined;
      const freshAgentId = state.projectId != null
        ? await resolveAgentId(cfg, state.projectId, name)
        : undefined;

      const result = await callElectron(cfg, callbackPort, '/internal/pty/spawn', {
        agentName: name,
        workDir: state.workDir || undefined,
        autoReport: state.autoReport,
        projectId: state.projectId ?? undefined,
        ...(freshAgentId != null ? { agentId: freshAgentId } : {}),
        ...(freshEffort ? { effort: freshEffort } : {}),
        ...(freshRuntime ? { runtime: freshRuntime } : {}),
      });

      if (result.status !== 200) {
        state.status = 'error';
        res.status(result.status).json(
          error('RESTART_FAILED', `Electron callback returned ${result.status}`, 'agent_restart', (req as any).requestId)
        );
        return;
      }

      const terminalId = result.data?.terminalId || result.data?.data?.terminalId || '';
      backoff.markSpawned(name, terminalId, session.sessionId || session.session?.sessionId || '', freshRuntime);

      res.json(success({
        agent_name: name,
        terminal_id: terminalId,
        session_id: state.sessionId,
        status: state.status,
        restart_count: state.restartCount,
      }, 'agent_restart', (req as any).requestId));
    } catch (err: any) {
      const msg = err.name === 'AbortError' ? 'Electron callback timeout' : err.message;
      res.status(502).json(
        error('RESTART_FAILED', `Restart failed: ${msg}`, 'agent_restart', (req as any).requestId)
      );
    }
  });

  // GET /v1/lifecycle/agents/:name/status
  router.get('/:name/status', (req: Request, res: Response) => {
    const name = req.params.name as string;
    const status = backoff.getStatus(name);

    if (!status) {
      res.status(404).json(
        error('AGENT_NOT_FOUND', `Agent ${name} not found`, 'agent_status', (req as any).requestId)
      );
      return;
    }

    res.json(success(status, 'agent_status', (req as any).requestId));
  });

  // GET /v1/lifecycle/agents — list all agents with status
  router.get('/', (req: Request, res: Response) => {
    const agents = backoff.getAll().map(state => backoff.getStatus(state.name));
    res.json(success({ agents, count: agents.length }, 'agent_list', (req as any).requestId));
  });

  // POST /internal/pty/exit — Electron reports PTY exit (internal, not proxied)
  router.post('/internal/pty-exit', (req: Request, res: Response) => {
    const { agentName, terminalId, exitCode } = req.body || {};

    if (!agentName || exitCode === undefined) {
      res.status(400).json(
        error('INVALID_REQUEST', 'agentName and exitCode required', 'pty_exit', (req as any).requestId)
      );
      return;
    }

    healthMonitor.handlePtyExit(agentName, terminalId || '', exitCode);

    res.json(success({
      agent_name: agentName,
      exit_code: exitCode,
      new_status: backoff.get(agentName)?.status || 'unknown',
    }, 'pty_exit', (req as any).requestId));
  });

  return router;
}
