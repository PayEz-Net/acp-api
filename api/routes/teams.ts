/**
 * ACP-1 + ACP-6 (WO-ACP-LIVE-TEAM-MERGE-2026-07-24): bearer proxy for the
 * cloud standing-team surface (PayEz-Core RelationalAgentTeamsController).
 *
 * `/v1/teams` is the ONE canonical sidecar prefix. Cloud serves the same
 * relational controller at both `/v1/teams` and `/v1/agent-teams`; we map
 * 1:1 onto `/v1/teams` and never expose the legacy prefix here.
 *
 * Cloud surface proxied (team CRUD + instances + compose — what the desktop
 * team-editor needs):
 *
 *   GET    /v1/teams                                  → list (standing-team picker source)
 *   POST   /v1/teams                                  → create
 *   POST   /v1/teams/compose                          → compose team + roster atomically
 *   GET    /v1/teams/:teamId                          → detail
 *   PUT    /v1/teams/:teamId                          → update
 *   DELETE /v1/teams/:teamId                          → soft-delete
 *   GET    /v1/teams/:teamId/instances                → list agent instances
 *   POST   /v1/teams/:teamId/instances                → add instance
 *   GET    /v1/teams/instances/:instanceId            → instance detail
 *   PUT    /v1/teams/instances/:instanceId            → update instance
 *   DELETE /v1/teams/instances/:instanceId            → remove instance
 *
 * Plus two compatibility aliases matching the desktop team-editor's existing
 * team-nested instance paths (cloud keys instance mutation by instanceId
 * alone; the teamId segment is validated then dropped):
 *
 *   PUT    /v1/teams/:teamId/instances/:instanceId    → cloud PUT /v1/teams/instances/:instanceId
 *   DELETE /v1/teams/:teamId/instances/:instanceId    → cloud DELETE /v1/teams/instances/:instanceId
 *
 * NOT proxied: GET /v1/agent-teams/:teamId/projects (removed upstream by
 * design) and the /projects/:projectId/assignment triple (assignment IS
 * engagement — use POST /v1/projects/:id/teams in projects.ts, ACP-1).
 *
 * All responses are VERBATIM passthroughs (cloud status + body, unwrapped —
 * same contract as the standup proxy in projects.ts) so the editor reads one
 * stable shape; cloud 4xx codes (NAME_CONFLICT, VALIDATION_ERROR, NOT_FOUND)
 * reach the caller untouched.
 */

import { Router, type Request, type Response } from 'express';
import { error } from '../response.js';
import type { Config } from '../../config.js';
import { ensureValidToken, forceRefresh, getSession, requireTokenClientId } from '../auth/tokenManager.js';

const PROXY_TIMEOUT_MS = 10_000;
const CLOUD_TEAMS_PATH = '/v1/teams';

class NotAuthenticatedError extends Error {
  constructor() {
    super('No active IDP session — user must log in via POST /v1/auth/login');
    this.name = 'NotAuthenticatedError';
  }
}

// Decision-C: Bearer-only (no Vibe HMAC secret in the user-session build).
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

function buildQueryString(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

async function callCloud(
  cfg: Config,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  query?: Record<string, unknown>,
  body?: unknown,
): Promise<{ status: number; payload: unknown }> {
  let token = await ensureValidToken(cfg.idpUrl);
  if (!token) throw new NotAuthenticatedError();

  const url = `${cfg.vibeApiUrl}${path}${buildQueryString(query)}`;

  const doFetch = async (bearer: string): Promise<{ status: number; payload: unknown }> => {
    const headers = buildAuthHeaders(cfg, bearer);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    try {
      const opts: RequestInit = { method, headers, signal: controller.signal };
      if (body !== undefined && method !== 'GET') {
        opts.body = JSON.stringify(body);
      }
      const res = await fetch(url, opts);
      const text = await res.text();
      if (!text) return { status: res.status, payload: { success: res.ok, data: null } };
      try {
        return { status: res.status, payload: JSON.parse(text) };
      } catch {
        return {
          status: res.status,
          payload: {
            success: false,
            error: {
              code: 'UPSTREAM_NON_JSON',
              message: `Upstream returned non-JSON (HTTP ${res.status}): ${text.slice(0, 400)}`,
            },
          },
        };
      }
    } finally {
      clearTimeout(timeout);
    }
  };

  const first = await doFetch(token);
  if (first.status !== 401) return first;

  const refreshed = await forceRefresh(cfg.idpUrl);
  if (!refreshed) throw new NotAuthenticatedError();
  return doFetch(refreshed);
}

function sendProxyError(res: Response, req: Request, err: any, op: string): void {
  if (err instanceof NotAuthenticatedError) {
    res.status(401).json(error('NOT_AUTHENTICATED', err.message, op, (req as any).requestId));
    return;
  }
  const reason = err?.name === 'AbortError' ? 'Upstream timeout (10s)' : err?.message || String(err);
  res.status(502).json(error('PROXY_ERROR', `Teams proxy failed: ${reason}`, op, (req as any).requestId));
}

function parseIdParam(raw: string | undefined): number | null {
  // Strict: the whole segment must be digits (parseInt alone would silently
  // accept "5abc" → 5 and proxy the wrong team).
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  return parseInt(raw, 10);
}

/**
 * Whitelist a request body down to the keys the cloud DTO for that route
 * actually accepts — never forward caller junk (or sidecar-local params like
 * force_refresh) upstream. `key in body` (not truthiness) keeps explicit
 * nulls, matching the tri-state contract elsewhere.
 */
function pickBody(body: unknown, keys: readonly string[]): Record<string, unknown> {
  const src = (body || {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k in src) out[k] = src[k];
  }
  return out;
}

// Cloud DTO key sets (PayEz-Core RelationalAgentTeamDtos).
const TEAM_CREATE_KEYS = ['name', 'display_name', 'team_type', 'purpose', 'description', 'defaults_json'] as const;
const TEAM_UPDATE_KEYS = [...TEAM_CREATE_KEYS, 'is_active'] as const;
const TEAM_COMPOSE_KEYS = [...TEAM_CREATE_KEYS, 'members'] as const;
const INSTANCE_CREATE_KEYS = [
  'agent_id', 'identity_prompt', 'expertise_tags', 'personality_preset',
  'role_preset', 'team_props_json', 'sort_order', 'is_lead',
] as const;
const INSTANCE_UPDATE_KEYS = [
  'identity_prompt', 'expertise_tags', 'personality_preset',
  'role_preset', 'team_props_json', 'sort_order', 'is_lead', 'is_active',
] as const;

export default function teamsRoutes(cfg: Config): Router {
  const router = Router();

  const proxy = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    matchPath: string,
    op: string,
    buildCloudPath: (req: Request) => string | null,
    getQuery?: (req: Request) => Record<string, unknown> | undefined,
    getBody?: (req: Request) => unknown,
  ) => {
    const handler = async (req: Request, res: Response) => {
      try {
        const session = getSession();
        if (!session) throw new NotAuthenticatedError();
        const cloudPath = buildCloudPath(req);
        if (cloudPath === null) {
          res.status(400).json(error('VALIDATION_ERROR', 'id params must be integers', op, (req as any).requestId));
          return;
        }
        const { status, payload } = await callCloud(cfg, method, cloudPath, getQuery?.(req), getBody?.(req));
        // VERBATIM passthrough — see file header.
        res.status(status).json(payload);
      } catch (err: any) {
        sendProxyError(res, req, err, op);
      }
    };
    if (method === 'GET') router.get(matchPath, handler);
    else if (method === 'POST') router.post(matchPath, handler);
    else if (method === 'PUT') router.put(matchPath, handler);
    else router.delete(matchPath, handler);
  };

  const teamPath = (req: Request): string | null => {
    const teamId = parseIdParam(req.params.teamId as string);
    return teamId === null ? null : `${CLOUD_TEAMS_PATH}/${teamId}`;
  };
  const instancePath = (req: Request): string | null => {
    const instanceId = parseIdParam(req.params.instanceId as string);
    return instanceId === null ? null : `${CLOUD_TEAMS_PATH}/instances/${instanceId}`;
  };

  // ── Teams ──────────────────────────────────────────────────────────────
  // Literal routes first: '/compose' must not be swallowed by '/:teamId'.
  proxy('GET', '/', 'teams_list', () => CLOUD_TEAMS_PATH,
    // activeOnly is the ONLY query param the cloud list accepts — never
    // forward sidecar-local params (force_refresh etc.) upstream.
    (req) => ({ activeOnly: req.query.activeOnly }));
  proxy('POST', '/', 'teams_create', () => CLOUD_TEAMS_PATH,
    undefined, (req) => pickBody(req.body, TEAM_CREATE_KEYS));
  proxy('POST', '/compose', 'teams_compose', () => `${CLOUD_TEAMS_PATH}/compose`,
    undefined, (req) => pickBody(req.body, TEAM_COMPOSE_KEYS));
  proxy('GET', '/:teamId', 'teams_get', teamPath);
  proxy('PUT', '/:teamId', 'teams_update', teamPath,
    undefined, (req) => pickBody(req.body, TEAM_UPDATE_KEYS));
  proxy('DELETE', '/:teamId', 'teams_delete', teamPath);

  // ── Team agent instances ───────────────────────────────────────────────
  proxy('GET', '/:teamId/instances', 'teams_instances_list',
    (req) => {
      const base = teamPath(req);
      return base === null ? null : `${base}/instances`;
    });
  proxy('POST', '/:teamId/instances', 'teams_instances_create',
    (req) => {
      const base = teamPath(req);
      return base === null ? null : `${base}/instances`;
    },
    undefined, (req) => pickBody(req.body, INSTANCE_CREATE_KEYS));
  proxy('GET', '/instances/:instanceId', 'teams_instance_get', instancePath);
  proxy('PUT', '/instances/:instanceId', 'teams_instance_update', instancePath,
    undefined, (req) => pickBody(req.body, INSTANCE_UPDATE_KEYS));
  proxy('DELETE', '/instances/:instanceId', 'teams_instance_delete', instancePath);
  // Compatibility aliases for the desktop team-editor's team-nested paths —
  // cloud keys instance mutation by instanceId alone.
  proxy('PUT', '/:teamId/instances/:instanceId', 'teams_instance_update',
    (req) => (teamPath(req) === null ? null : instancePath(req)),
    undefined, (req) => pickBody(req.body, INSTANCE_UPDATE_KEYS));
  proxy('DELETE', '/:teamId/instances/:instanceId', 'teams_instance_delete',
    (req) => (teamPath(req) === null ? null : instancePath(req)));

  return router;
}
