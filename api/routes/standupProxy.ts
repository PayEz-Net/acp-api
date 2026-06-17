import { Router, type Request, type Response } from 'express';
import { error } from '../response.js';
import type { Config } from '../../config.js';
import { ensureValidToken, forceRefresh, requireTokenClientId } from '../auth/tokenManager.js';

/**
 * Standup (Team Check-in) proxy — #66 W1, contract step 4.
 *
 * The desktop check-in board (acp-desktop/src/renderer/checkin/api.ts) calls the
 * NESTED project-scoped routes on this sidecar; we forward them verbatim to the
 * typed .NET vibe-api (PayEz.Vibe.Public.Api StandupRoundsController), which owns
 * the durable Round/Report doc-store. Pass-through: whatever the cloud returns
 * ({ round } / { rounds }) is relayed unchanged so the FE reads it directly —
 * same envelope discipline as mailProxy.
 *
 * Mounted at /v1/projects (BEFORE projectRoutes) so the deeper /standup/* paths
 * match here; non-standup /v1/projects/* fall through to the projects proxy.
 *
 * Auth: Bearer-only (refresh-on-401). Decision-C — no Vibe HMAC secret in the
 * user-session build; HMAC stays machine-only (contractors). The cloud's
 * VibeClientAuthMiddleware accepts a validated IDP Bearer with a client_id claim
 * in lieu of HMAC, so the session token is sufficient (same as mailProxy).
 */

const PROXY_TIMEOUT_MS = 10_000;

class NotAuthenticatedError extends Error {
  constructor() {
    super('No active IDP session — user must log in via POST /v1/auth/login');
    this.name = 'NotAuthenticatedError';
  }
}

// X-Client-Id mirrors the bearer's own client_id (the user's tenant), not the
// retired hardcoded idealvibe client — see requireTokenClientId.
function buildAuthHeaders(_cfg: Config, token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'X-Client-Id': requireTokenClientId(token),
    'X-Vibe-Via': 'idp-proxy',
    'Content-Type': 'application/json',
  };
}

function buildQueryString(query: Record<string, any>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    // project_id is structural (in the path) for these routes — don't double it.
    if (key === 'project_id') continue;
    if (value !== undefined && value !== null) {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

async function proxyToCloud(
  cfg: Config,
  path: string,
  method: string,
  query?: Record<string, any>,
  body?: unknown,
  agentName?: string,
): Promise<{ status: number; data: unknown }> {
  const qs = query ? buildQueryString(query) : '';
  const url = `${cfg.vibeApiUrl}${path}${qs}`;

  let token = await ensureValidToken(cfg.idpUrl, 'ensureValidToken@standup');
  if (!token) {
    throw new NotAuthenticatedError();
  }

  const doFetch = async (bearer: string): Promise<{ status: number; data: unknown }> => {
    const headers = buildAuthHeaders(cfg, bearer);
    // Forward the agent identity (report-filing authz, #67 W2 / S8a). The sidecar
    // is the trusted local boundary; the cloud reads X-ACP-Agent when no agent JWT.
    if (agentName) {
      headers['X-ACP-Agent'] = agentName;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    try {
      const opts: RequestInit = { method, headers, signal: controller.signal };
      if (body !== undefined && (method === 'POST' || method === 'PUT')) {
        opts.body = JSON.stringify(body);
      }
      const res = await fetch(url, opts);
      const text = await res.text();
      if (!text) {
        return { status: res.status, data: { success: res.ok, data: null } };
      }
      try {
        return { status: res.status, data: JSON.parse(text) };
      } catch {
        return {
          status: res.status,
          data: {
            success: false,
            error: {
              code: 'UPSTREAM_NON_JSON',
              message: `Upstream returned non-JSON body (HTTP ${res.status}): ${text.slice(0, 400)}`,
            },
          },
        };
      }
    } finally {
      clearTimeout(timeout);
    }
  };

  const firstAttempt = await doFetch(token);
  if (firstAttempt.status !== 401) {
    return firstAttempt;
  }
  const refreshed = await forceRefresh(cfg.idpUrl, 'forceRefresh-on-401@standup');
  if (!refreshed) {
    throw new NotAuthenticatedError();
  }
  return doFetch(refreshed);
}

function sendProxyError(res: Response, req: Request, err: any, operation: string): void {
  if (err instanceof NotAuthenticatedError) {
    res.status(401).json(error('NOT_AUTHENTICATED', err.message, operation, (req as any).requestId));
    return;
  }
  const msg = err.name === 'AbortError' ? 'Upstream timeout (10s)' : err.message;
  res.status(502).json(error('PROXY_ERROR', `Standup proxy failed: ${msg}`, operation, (req as any).requestId));
}

function cloudBase(projectId: string): string {
  return `/v1/projects/${encodeURIComponent(projectId)}/standup`;
}

export default function standupProxyRoutes(cfg: Config): Router {
  const router = Router();

  // POST /v1/projects/:projectId/standup/rounds -> open a round
  router.post('/:projectId/standup/rounds', async (req: Request, res: Response) => {
    try {
      const result = await proxyToCloud(cfg, `${cloudBase(String(req.params.projectId))}/rounds`, 'POST', req.query as any, req.body);
      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'standup_open_round');
    }
  });

  // GET /v1/projects/:projectId/standup/rounds/current -> current round (before :roundId)
  router.get('/:projectId/standup/rounds/current', async (req: Request, res: Response) => {
    try {
      const result = await proxyToCloud(cfg, `${cloudBase(String(req.params.projectId))}/rounds/current`, 'GET', req.query as any);
      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'standup_current_round');
    }
  });

  // POST /v1/projects/:projectId/standup/rounds/:roundId/close -> close a round
  router.post('/:projectId/standup/rounds/:roundId/close', async (req: Request, res: Response) => {
    try {
      const result = await proxyToCloud(
        cfg,
        `${cloudBase(String(req.params.projectId))}/rounds/${encodeURIComponent(String(req.params.roundId))}/close`,
        'POST',
        req.query as any,
        req.body,
      );
      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'standup_close_round');
    }
  });

  // POST /v1/projects/:projectId/standup/rounds/:roundId/report -> file the agent's own report
  router.post('/:projectId/standup/rounds/:roundId/report', async (req: Request, res: Response) => {
    try {
      const agentName = (req.headers['x-acp-agent'] as string | undefined)
        || (req as any).agentName as string | undefined;
      const result = await proxyToCloud(
        cfg,
        `${cloudBase(String(req.params.projectId))}/rounds/${encodeURIComponent(String(req.params.roundId))}/report`,
        'POST',
        req.query as any,
        req.body,
        agentName,
      );
      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'standup_file_report');
    }
  });

  // GET /v1/projects/:projectId/standup/rounds/:roundId -> one round
  router.get('/:projectId/standup/rounds/:roundId', async (req: Request, res: Response) => {
    try {
      const result = await proxyToCloud(
        cfg,
        `${cloudBase(String(req.params.projectId))}/rounds/${encodeURIComponent(String(req.params.roundId))}`,
        'GET',
        req.query as any,
      );
      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'standup_get_round');
    }
  });

  // GET /v1/projects/:projectId/standup/rounds -> list rounds
  router.get('/:projectId/standup/rounds', async (req: Request, res: Response) => {
    try {
      const result = await proxyToCloud(cfg, `${cloudBase(String(req.params.projectId))}/rounds`, 'GET', req.query as any);
      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'standup_list_rounds');
    }
  });

  // GET /v1/projects/:projectId/standup/schedule -> read schedule
  router.get('/:projectId/standup/schedule', async (req: Request, res: Response) => {
    try {
      const result = await proxyToCloud(cfg, `${cloudBase(String(req.params.projectId))}/schedule`, 'GET', req.query as any);
      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'standup_get_schedule');
    }
  });

  // PUT /v1/projects/:projectId/standup/schedule -> upsert schedule
  router.put('/:projectId/standup/schedule', async (req: Request, res: Response) => {
    try {
      const result = await proxyToCloud(cfg, `${cloudBase(String(req.params.projectId))}/schedule`, 'PUT', req.query as any, req.body);
      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'standup_set_schedule');
    }
  });

  return router;
}
