import { Router, type Request, type Response } from 'express';
import { error, success } from '../response.js';
import type { Config } from '../../config.js';
import { ensureValidToken, forceRefresh, getSession, requireTokenClientId } from '../auth/tokenManager.js';

import * as teamCache from '../team/cache.js';
import { type NormalizedAgent } from '../team/mapper.js';

// v1.6 (Jon directive 2026-05-16): upstream /v1/agents/startup-config
// returns duplicate agent_profiles rows from vibe.documents. Switched to
// /v1/projects/:id/team which pulls from vibe_projects.project_team_members
// and returns exactly one row per agent. Same cache key (userId, projectId).
const PROJECT_TEAM_PATH = '/v1/projects';
const PROXY_TIMEOUT_MS = 10_000;

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

interface CloudFetchResult {
  ok: true;
  agents: NormalizedAgent[];
}
interface CloudFetchFailure {
  ok: false;
  reason: 'auth' | 'timeout' | 'http_error' | 'parse_error';
  detail?: string;
}

async function fetchTeamFromCloud(cfg: Config, projectId: number): Promise<CloudFetchResult | CloudFetchFailure> {
  // GET /v1/projects/:id/team — canonical project-scoped team read.
  // Returns one row per agent from project_team_members (no doc-store dupes).
  const signedPath = `${PROJECT_TEAM_PATH}/${projectId}/team`;
  const url = `${cfg.vibeApiUrl}${signedPath}`;

  let token = await ensureValidToken(cfg.idpUrl);
  if (!token) {
    return { ok: false, reason: 'auth' };
  }

  const doFetch = async (bearer: string): Promise<{ status: number; body: any; raw: string }> => {
    const headers = buildAuthHeaders(cfg, bearer);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      const raw = await res.text();
      let body: any = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* leave null */ }
      return { status: res.status, body, raw };
    } finally {
      clearTimeout(timeout);
    }
  };

  let attempt: { status: number; body: any; raw: string };
  try {
    attempt = await doFetch(token);
  } catch (err: any) {
    return { ok: false, reason: err?.name === 'AbortError' ? 'timeout' : 'http_error', detail: err?.message };
  }

  if (attempt.status === 401) {
    const refreshed = await forceRefresh(cfg.idpUrl);
    if (!refreshed) return { ok: false, reason: 'auth' };
    try {
      attempt = await doFetch(refreshed);
    } catch (err: any) {
      return { ok: false, reason: err?.name === 'AbortError' ? 'timeout' : 'http_error', detail: err?.message };
    }
  }

  if (attempt.status < 200 || attempt.status >= 300) {
    return { ok: false, reason: 'http_error', detail: `HTTP ${attempt.status}` };
  }

  const team = attempt.body?.data?.team;
  if (!Array.isArray(team)) {
    return { ok: false, reason: 'parse_error', detail: 'response missing data.team array' };
  }

  // Map ProjectTeamMember → NormalizedAgent (shape the renderer expects).
  const agents: NormalizedAgent[] = team
    .filter((m: any) => m && typeof m.agent_id === 'number' && typeof m.agent_name === 'string')
    .map((m: any) => ({
      id: m.agent_id,
      name: m.agent_name,
      displayName: m.agent_display_name || m.agent_name,
      isActive: true,
      rolePreset: m.canonical_role || m.role || undefined,
      isCoordinator: m.is_lead === true,
      // project_team_members doesn't carry these; grid falls back gracefully
      startupOrder: undefined,
      expertiseTags: undefined,
    }));

  return { ok: true, agents };
}

/**
 * #16b — resolve a single team member's effort_override FRESH from the DB
 * (vibe_projects.project_team_members via vibe-api) at agent respawn.
 *
 * ONE source of truth, always current: a backoff-state cache of the effort
 * VALUE would drift if the user edits effort during the crash/backoff window
 * (Aurum 1421 mini-hydra; QA drift test: edit max->medium mid-crash -> the
 * restart must respawn at MEDIUM). This does a fresh authoritative read every
 * time (no teamCache — that has a 60s TTL and could also be stale).
 *
 * Returns the narrowed effort, or undefined when: unknown agent, no override
 * (null), no active session, or any fetch failure. undefined -> the caller
 * OMITS effort -> the single spawn resolver defers to the global default.
 * Never substitutes 'high' here (Aurum 1413: one resolver owns 'high').
 */
/**
 * Resolve a team member's numeric agent_id from the canonical project team.
 * Mirrors resolveMemberEffort/resolveTeamRuntime: always authoritative, no cache.
 */
export async function resolveAgentId(
  cfg: Config,
  projectId: number,
  agentName: string,
): Promise<number | undefined> {
  const signedPath = `${PROJECT_TEAM_PATH}/${projectId}/team`;
  const url = `${cfg.vibeApiUrl}${signedPath}`;
  let token = await ensureValidToken(cfg.idpUrl);
  if (!token) return undefined;

  const doFetch = async (bearer: string): Promise<{ status: number; body: any }> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'GET', headers: buildAuthHeaders(cfg, bearer), signal: controller.signal });
      const raw = await res.text();
      let body: any = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* leave null */ }
      return { status: res.status, body };
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    let attempt = await doFetch(token);
    if (attempt.status === 401) {
      const refreshed = await forceRefresh(cfg.idpUrl);
      if (!refreshed) return undefined;
      attempt = await doFetch(refreshed);
    }
    if (attempt.status < 200 || attempt.status >= 300) return undefined;
    const team = attempt.body?.data?.team;
    if (!Array.isArray(team)) return undefined;
    const member = team.find((m: any) => m && m.agent_name === agentName);
    return typeof member?.agent_id === 'number' ? member.agent_id : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveMemberEffort(
  cfg: Config,
  projectId: number,
  agentName: string,
): Promise<'low' | 'medium' | 'high' | 'max' | undefined> {
  const signedPath = `${PROJECT_TEAM_PATH}/${projectId}/team`;
  const url = `${cfg.vibeApiUrl}${signedPath}`;
  let token = await ensureValidToken(cfg.idpUrl);
  if (!token) return undefined; // no session -> can't look up -> defer to global

  const doFetch = async (bearer: string): Promise<{ status: number; body: any }> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'GET', headers: buildAuthHeaders(cfg, bearer), signal: controller.signal });
      const raw = await res.text();
      let body: any = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* leave null */ }
      return { status: res.status, body };
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    let attempt = await doFetch(token);
    if (attempt.status === 401) {
      const refreshed = await forceRefresh(cfg.idpUrl);
      if (!refreshed) return undefined;
      attempt = await doFetch(refreshed);
    }
    if (attempt.status < 200 || attempt.status >= 300) return undefined;
    const team = attempt.body?.data?.team;
    if (!Array.isArray(team)) return undefined;
    const member = team.find((m: any) => m && m.agent_name === agentName);
    const e = member?.effort_override;
    return (e === 'low' || e === 'medium' || e === 'high' || e === 'max') ? e : undefined;
  } catch {
    return undefined;
  }
}

/**
 * WO #84135 §3.1 — the SINGLE source-of-truth resolver for a project's TEAM
 * runtime (claude | kimi). Runtime is a TEAM-level setting (one value
 * per project, applied to every agent — §1, Jon 2026-06-16), unlike the
 * per-member effort_override above.
 *
 * Reads `runtime_choice` FRESH from the project record (`GET /v1/projects/:id`
 * detail → data.project.runtime_choice) every call — no teamCache (60s TTL
 * could serve a stale value if the user changed the team runtime mid-window).
 * Same fallback-hydra fix as effort: ONE resolver, always authoritative.
 *
 * Every spawn-class path (fresh spawn forwards it from the renderer; the
 * RESTART route re-resolves through this; orchestrator) resolves runtime here
 * so a restart can never silently flip a kimi team's agent to the global
 * default (§2.3 — the asymmetry-with-effort bug).
 *
 * Returns the narrowed runtime, or undefined when: no active session, fetch
 * failure, or `runtime_choice` is unset/null on the project. undefined -> the
 * caller OMITS runtime (symmetry with effort). NOTE: killing the global-fallback
 * MASKING of an unset team runtime (§3.3) is a SEPARATE slice (spec §9 step 5);
 * this resolver intentionally does not substitute a default for null.
 */
export async function resolveTeamRuntime(
  cfg: Config,
  projectId: number,
): Promise<'claude' | 'kimi' | undefined> {
  const signedPath = `${PROJECT_TEAM_PATH}/${projectId}`;
  const url = `${cfg.vibeApiUrl}${signedPath}`;
  let token = await ensureValidToken(cfg.idpUrl);
  if (!token) return undefined; // no session -> can't look up -> defer to caller

  const doFetch = async (bearer: string): Promise<{ status: number; body: any }> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'GET', headers: buildAuthHeaders(cfg, bearer), signal: controller.signal });
      const raw = await res.text();
      let body: any = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* leave null */ }
      return { status: res.status, body };
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    let attempt = await doFetch(token);
    if (attempt.status === 401) {
      const refreshed = await forceRefresh(cfg.idpUrl);
      if (!refreshed) return undefined;
      attempt = await doFetch(refreshed);
    }
    if (attempt.status < 200 || attempt.status >= 300) return undefined;
    const r = attempt.body?.data?.project?.runtime_choice;
    return (r === 'claude' || r === 'kimi') ? r : undefined;
  } catch {
    return undefined;
  }
}

interface SyncPayload {
  agents: NormalizedAgent[];
  source: 'cloud' | 'cache' | 'defaults';
  fetchedAt: string;
  warning?: string;
}

// §3.3 universal-pair fallback (BAPert Decision 3a): when cloud unreachable
// + no cache for (userId, projectId), return the universal pair (BAPert + QAPert)
// so the desktop renders SOMETHING useful instead of an empty grid. Renderer
// surfaces this with a "Working offline with default team" banner driven by
// the wrapper-level `source: 'defaults'` signal — per-agent flag was redundant
// (N1 amendment, QAPert msg 961 F1) and removed.
const UNIVERSAL_PAIR_FALLBACK: NormalizedAgent[] = [
  { id: 0, name: 'BAPert', displayName: 'BAPert', isActive: true },
  { id: 0, name: 'QAPert', displayName: 'QAPert', isActive: true },
];

async function syncTeam(cfg: Config, projectId: number, force: boolean): Promise<SyncPayload | { needsAuth: true }> {
  const session = getSession();
  if (!session) return { needsAuth: true };
  const userId = session.userId;

  if (!force) {
    const fresh = teamCache.getFresh(userId, projectId);
    if (fresh) {
      return { agents: fresh.agents, source: 'cache', fetchedAt: fresh.fetchedAt };
    }
  }

  const cloud = await fetchTeamFromCloud(cfg, projectId);
  if (cloud.ok) {
    const entry = teamCache.set(userId, projectId, cloud.agents);
    return { agents: cloud.agents, source: 'cloud', fetchedAt: entry.fetchedAt };
  }

  if (cloud.reason === 'auth') {
    return { needsAuth: true };
  }

  // Cloud unreachable — fall back to last cached entry for this (userId, projectId), regardless of TTL.
  const stale = teamCache.getStale(userId, projectId);
  if (stale) {
    return {
      agents: stale.agents,
      source: 'cache',
      fetchedAt: stale.fetchedAt,
      warning: `Cloud unreachable (${cloud.reason}); serving last-known team`,
    };
  }

  // §3.3 Decision 3a: universal pair when cloud-unreachable + cache-absent.
  return {
    agents: UNIVERSAL_PAIR_FALLBACK,
    source: 'defaults',
    fetchedAt: new Date().toISOString(),
    warning: `Cloud unreachable (${cloud.reason}) and no cached team available`,
  };
}

function parseProjectId(req: Request): { ok: true; value: number } | { ok: false; message: string } {
  const raw = req.query.project_id;
  if (raw === undefined || raw === null || raw === '') {
    return { ok: false, message: 'project_id query parameter is required (positive integer)' };
  }
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, message: 'project_id must be a positive integer' };
  }
  return { ok: true, value: n };
}

export default function teamRoutes(cfg: Config): Router {
  const router = Router();

  router.get('/sync', async (req: Request, res: Response) => {
    const projectId = parseProjectId(req);
    if (!projectId.ok) {
      res.status(400).json(error('MISSING_PROJECT_ID', projectId.message, 'team_sync', (req as any).requestId));
      return;
    }
    const force = String(req.query.force_refresh || '').toLowerCase() === 'true';
    try {
      const result = await syncTeam(cfg, projectId.value, force);
      if ('needsAuth' in result) {
        res.status(401).json(error('NOT_AUTHENTICATED', 'No active IDP session', 'team_sync', (req as any).requestId));
        return;
      }
      res.json(success(result, 'team_sync', (req as any).requestId));
    } catch (err: any) {
      if (err instanceof NotAuthenticatedError) {
        res.status(401).json(error('NOT_AUTHENTICATED', err.message, 'team_sync', (req as any).requestId));
        return;
      }
      res.status(502).json(error('TEAM_SYNC_ERROR', `Team sync failed: ${err?.message || err}`, 'team_sync', (req as any).requestId));
    }
  });

  router.get('/refresh', async (req: Request, res: Response) => {
    const projectId = parseProjectId(req);
    if (!projectId.ok) {
      res.status(400).json(error('MISSING_PROJECT_ID', projectId.message, 'team_refresh', (req as any).requestId));
      return;
    }
    try {
      const result = await syncTeam(cfg, projectId.value, true);
      if ('needsAuth' in result) {
        res.status(401).json(error('NOT_AUTHENTICATED', 'No active IDP session', 'team_refresh', (req as any).requestId));
        return;
      }
      res.json(success(result, 'team_refresh', (req as any).requestId));
    } catch (err: any) {
      res.status(502).json(error('TEAM_REFRESH_ERROR', `Team refresh failed: ${err?.message || err}`, 'team_refresh', (req as any).requestId));
    }
  });

  return router;
}
