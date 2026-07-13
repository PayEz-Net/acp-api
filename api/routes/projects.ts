/**
 * Wave 2 + post-rename: cloud proxy for `/v1/projects` + current-project pointer.
 *
 * Local-Map echo retired. acp-api now proxies vibe-publicapi via the bearer
 * + HMAC envelope shared with team.ts / mailProxy.ts. Cloud surface (post
 * DotNetPert msg 1008 rename + archive guard, image 661332fe30ac):
 *
 *   GET  /v1/projects?activeOnly=true&search=...        → list
 *   GET  /v1/projects/:id                               → detail + members
 *   GET  /v1/users/me/current-project                   → focus pointer
 *   PUT  /v1/users/me/current-project { project_id }    → focus writeback
 *
 * FE-facing surface mirrors the cloud rename:
 *
 *   GET  /v1/projects/sync                              → unified envelope
 *                                                          (projects[] +
 *                                                          current_project_id +
 *                                                          current_project_state +
 *                                                          source)
 *   GET  /v1/projects                                   → list passthrough
 *   GET  /v1/projects/:id                               → detail passthrough
 *   GET  /v1/projects/current                           → focus pointer (200 always)
 *   POST /v1/projects/current { project_id }            → focus writeback
 *                                                          (POST→PUT bridge to cloud)
 *
 * Three-state focus enum is `stored | unset | empty` (spec §5.4):
 *   - 'stored' → render normally
 *   - 'unset'  → first-boot prompt picker (no auto-load — feedback_no_unjustified_fallback)
 *   - 'empty'  → create-CTA pointing at idealvibe.online
 *
 * Archive guard (Wave A.1 rename ship): PUT to is_active=false project →
 * 400 PROJECT_ARCHIVED; soft-deleted → 404 PROJECT_NOT_FOUND; cross-tenant →
 * 403 PROJECT_FORBIDDEN. These error codes flow through unchanged from cloud.
 *
 * POST /, PATCH /:id, DELETE /:id → 410 GONE (CRUD lives on idealvibe per
 * spec §3 non-goals).
 */

import { Router, type Request, type Response } from 'express';
import { success, error } from '../response.js';
import type { Config } from '../../config.js';
import type { LocalEventBus } from '../sse/localEventBus.js';
import { ensureValidToken, forceRefresh, getSession, requireTokenClientId } from '../auth/tokenManager.js';

import {
  extractAndMapList,
  extractAndMapCurrent,
  extractAndMapDetail,
  extractAndMapTeam,
  extractTeamMemberEcho,
  mapCloudProject,
  type MappedProject,
  type CurrentProjectState,
} from '../projects/mapper.js';
import * as cache from '../projects/cache.js';

const PROXY_TIMEOUT_MS = 10_000;
const CLOUD_PROJECTS_PATH = '/v1/projects';
const CLOUD_CURRENT_PROJECT_PATH = '/v1/users/me/current-project';

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
  const clientId = requireTokenClientId(token);
  return {
    'Authorization': `Bearer ${token}`,
    'X-Client-Id': clientId,
    'X-Vibe-Via': 'idp-proxy',
    'Content-Type': 'application/json',
  };
}

function buildQueryString(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && k !== 'force_refresh') {
      params.set(k, String(v));
    }
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

  const qs = buildQueryString(query);
  const url = `${cfg.vibeApiUrl}${path}${qs}`;

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
  res.status(502).json(error('PROXY_ERROR', `Project proxy failed: ${reason}`, op, (req as any).requestId));
}

interface ListResult {
  projects: MappedProject[];
  source: 'cloud' | 'cache' | 'defaults';
  fetchedAt: string;
  warning?: string;
}

interface CurrentResult {
  current_project_id: number | null;
  project: MappedProject | null;
  current_project_state: CurrentProjectState;
  source: 'cloud' | 'cache' | 'defaults';
  fetchedAt: string;
  warning?: string;
}

async function readList(
  cfg: Config,
  userId: string,
  query: Record<string, unknown>,
  forceRefreshFlag: boolean,
): Promise<ListResult> {
  if (!forceRefreshFlag) {
    const fresh = cache.list.getFresh(userId);
    if (fresh) return { projects: fresh.projects, source: 'cache', fetchedAt: fresh.fetchedAt };
  }
  try {
    const effective: Record<string, unknown> = { activeOnly: 'true', ...query };
    const { status, payload } = await callCloud(cfg, 'GET', CLOUD_PROJECTS_PATH, effective);
    if (status >= 200 && status < 300 && (payload as any)?.success) {
      const projects = extractAndMapList(payload);
      const entry = cache.list.set(userId, projects);
      console.log(
        '[ProjectsProxy] project list for user', userId,
        '→', projects.length, 'projects:',
        projects.map((p) => ({ id: p.id, name: p.name, status: p.status, is_active: p.is_active }))
      );
      return { projects, source: 'cloud', fetchedAt: entry.fetchedAt };
    }
    const stale = cache.list.getStale(userId);
    if (stale) {
      return {
        projects: stale.projects,
        source: 'cache',
        fetchedAt: stale.fetchedAt,
        warning: `Cloud returned HTTP ${status}; serving last-known list`,
      };
    }
    return {
      projects: [],
      source: 'defaults',
      fetchedAt: new Date().toISOString(),
      warning: `Cloud returned HTTP ${status}; no cache available`,
    };
  } catch (err: any) {
    if (err instanceof NotAuthenticatedError) throw err;
    const stale = cache.list.getStale(userId);
    const reason = err?.name === 'AbortError' ? 'Cloud unreachable (timeout)' : `Cloud unreachable (${err?.message || 'error'})`;
    if (stale) {
      return {
        projects: stale.projects,
        source: 'cache',
        fetchedAt: stale.fetchedAt,
        warning: `${reason}; serving last-known list`,
      };
    }
    return {
      projects: [],
      source: 'defaults',
      fetchedAt: new Date().toISOString(),
      warning: `${reason}; no cache available`,
    };
  }
}

async function readCurrent(
  cfg: Config,
  userId: string,
  forceRefreshFlag: boolean,
): Promise<CurrentResult> {
  if (!forceRefreshFlag) {
    const fresh = cache.current.getFresh(userId);
    if (fresh) {
      return {
        current_project_id: fresh.current_project_id,
        project: fresh.project,
        current_project_state: fresh.current_project_state,
        source: 'cache',
        fetchedAt: fresh.fetchedAt,
      };
    }
  }
  try {
    const { status, payload } = await callCloud(cfg, 'GET', CLOUD_CURRENT_PROJECT_PATH);
    if (status >= 200 && status < 300 && (payload as any)?.success) {
      const mapped = extractAndMapCurrent(payload);
      const entry = cache.current.set(userId, mapped);
      console.log(
        '[ProjectsProxy] current-project for user', userId,
        '→ project_id:', entry.current_project_id,
        'project:', entry.project ? { id: entry.project.id, name: entry.project.name, status: entry.project.status, is_active: entry.project.is_active } : null,
        'state:', entry.current_project_state
      );
      return {
        current_project_id: entry.current_project_id,
        project: entry.project,
        current_project_state: entry.current_project_state,
        source: 'cloud',
        fetchedAt: entry.fetchedAt,
      };
    }
    const stale = cache.current.getStale(userId);
    if (stale) {
      return {
        current_project_id: stale.current_project_id,
        project: stale.project,
        current_project_state: stale.current_project_state,
        source: 'cache',
        fetchedAt: stale.fetchedAt,
        warning: `Cloud returned HTTP ${status}; serving last-known current`,
      };
    }
    // No cache, cloud unhappy → conservative default: 'unset'. The FE will
    // render the first-boot prompt; that's the safe assumption when we
    // genuinely don't know whether a row exists. Better than silently
    // assuming 'empty' (would show create-CTA over a real-but-unreachable
    // user account).
    return {
      current_project_id: null,
      project: null,
      current_project_state: 'unset',
      source: 'defaults',
      fetchedAt: new Date().toISOString(),
      warning: `Cloud returned HTTP ${status}; no cache available`,
    };
  } catch (err: any) {
    if (err instanceof NotAuthenticatedError) throw err;
    const stale = cache.current.getStale(userId);
    const reason = err?.name === 'AbortError' ? 'Cloud unreachable (timeout)' : `Cloud unreachable (${err?.message || 'error'})`;
    if (stale) {
      return {
        current_project_id: stale.current_project_id,
        project: stale.project,
        current_project_state: stale.current_project_state,
        source: 'cache',
        fetchedAt: stale.fetchedAt,
        warning: `${reason}; serving last-known current`,
      };
    }
    return {
      current_project_id: null,
      project: null,
      current_project_state: 'unset',
      source: 'defaults',
      fetchedAt: new Date().toISOString(),
      warning: `${reason}; no cache available`,
    };
  }
}

export default function projectRoutes(eventBus: LocalEventBus, cfg: Config): Router {
  const router = Router();

  // GET /v1/projects/sync — unified envelope.
  // Single round-trip from FE that wants the consolidated view. The two
  // internal reads share the cache layer, so the cloud sees at most two
  // calls regardless of which legacy endpoint the FE hits.
  router.get('/sync', async (req: Request, res: Response) => {
    try {
      const session = getSession();
      if (!session) throw new NotAuthenticatedError();
      const userId = session.userId || '0';
      const forceRefreshFlag = String(req.query.force_refresh || '') === 'true';

      const [listR, currentR] = await Promise.all([
        readList(cfg, userId, req.query as Record<string, unknown>, forceRefreshFlag),
        readCurrent(cfg, userId, forceRefreshFlag),
      ]);

      // Combined source resolution: if either side is cache/defaults,
      // surface that on the wire (the FE banner pattern). 'cloud' only when
      // both succeed live.
      const combinedSource: 'cloud' | 'cache' | 'defaults' =
        listR.source === 'cloud' && currentR.source === 'cloud'
          ? 'cloud'
          : listR.source === 'defaults' || currentR.source === 'defaults'
            ? 'defaults'
            : 'cache';
      const warning = listR.warning ?? currentR.warning;

      res.json(success(
        {
          projects: listR.projects,
          current_project_id: currentR.current_project_id,
          current_project_state: currentR.current_project_state,
          source: combinedSource,
          fetchedAt: listR.fetchedAt,
          ...(warning ? { warning } : {}),
        },
        'projects_sync',
        (req as any).requestId,
      ));
    } catch (err: any) {
      sendProxyError(res, req, err, 'projects_sync');
    }
  });

  // GET /v1/projects — list of projects for authed developer.
  router.get('/', async (req: Request, res: Response) => {
    try {
      const session = getSession();
      if (!session) throw new NotAuthenticatedError();
      const userId = session.userId || '0';
      const forceRefreshFlag = String(req.query.force_refresh || '') === 'true';
      const result = await readList(cfg, userId, req.query as Record<string, unknown>, forceRefreshFlag);
      res.json(success(
        {
          projects: result.projects,
          source: result.source,
          fetchedAt: result.fetchedAt,
          ...(result.warning ? { warning: result.warning } : {}),
        },
        'projects_list',
        (req as any).requestId,
      ));
    } catch (err: any) {
      sendProxyError(res, req, err, 'projects_list');
    }
  });

  // GET /v1/projects/current — current-project pointer.
  // Always returns 200 (no 404 on null project). FE reads
  // `current_project_state` and renders accordingly.
  router.get('/current', async (req: Request, res: Response) => {
    try {
      const session = getSession();
      if (!session) throw new NotAuthenticatedError();
      const userId = session.userId || '0';
      const forceRefreshFlag = String(req.query.force_refresh || '') === 'true';
      const result = await readCurrent(cfg, userId, forceRefreshFlag);
      res.json(success(
        {
          project: result.project,
          current_project_id: result.current_project_id,
          current_project_state: result.current_project_state,
          source: result.source,
          fetchedAt: result.fetchedAt,
          ...(result.warning ? { warning: result.warning } : {}),
        },
        'project_current',
        (req as any).requestId,
      ));
    } catch (err: any) {
      sendProxyError(res, req, err, 'project_current');
    }
  });

  // POST /v1/projects/current { project_id } — bridge to cloud PUT.
  // Cloud-side error codes (PROJECT_ARCHIVED 400, PROJECT_NOT_FOUND 404,
  // PROJECT_FORBIDDEN 403) flow through with their original HTTP status.
  router.post('/current', async (req: Request, res: Response) => {
    try {
      const session = getSession();
      if (!session) throw new NotAuthenticatedError();
      const userId = session.userId || '0';
      const { project_id } = req.body || {};
      if (project_id !== null && (project_id === undefined || isNaN(parseInt(String(project_id), 10)))) {
        res.status(400).json(error('VALIDATION_ERROR', 'project_id required (integer or null to clear)', 'project_set_current', (req as any).requestId));
        return;
      }
      const idForCloud = project_id === null ? null : parseInt(String(project_id), 10);

      // POST → PUT bridge to cloud.
      const { status, payload } = await callCloud(cfg, 'PUT', CLOUD_CURRENT_PROJECT_PATH, undefined, { project_id: idForCloud });

      // Pass cloud error codes through with their original HTTP status so
      // FE switches on the real archive guard / forbidden / not-found
      // distinctions.
      if (status === 400 || status === 403 || status === 404) {
        const upstreamError = (payload as any)?.error ?? {};
        const code = upstreamError.code || (status === 400 ? 'BAD_REQUEST' : status === 403 ? 'PROJECT_FORBIDDEN' : 'PROJECT_NOT_FOUND');
        const message = upstreamError.message || `Cloud returned HTTP ${status}`;
        res.status(status).json(error(code, message, 'project_set_current', (req as any).requestId));
        return;
      }
      if (status < 200 || status >= 300 || !(payload as any)?.success) {
        const upstreamMsg = (payload as any)?.error?.message || `Cloud writeback returned HTTP ${status}`;
        res.status(502).json(error('PROXY_ERROR', upstreamMsg, 'project_set_current', (req as any).requestId));
        return;
      }

      // Invalidate current-pointer cache so the next sync sees the change
      // immediately. List cache stays — switching focus doesn't change
      // membership.
      cache.current.clear(userId);

      const data = (payload as any).data ?? {};
      const cloudProject = data.project ?? null;
      const current_project_id = typeof data.current_project_id === 'number' ? data.current_project_id : (idForCloud ?? null);

      // SSE emit — preserves existing FE listeners (useAcpSse →
      // projectStore.handleProjectSwitched → syncTeam force-refresh).
      if (current_project_id) {
        eventBus.emit({
          event: 'project-switched',
          data: {
            project_id: current_project_id,
            project_name: cloudProject?.name || '',
          },
        });
      }

      // Reuse the canonical mapper so writeback responses carry the same
      // Wave A.1 enriched shape (12 attribute fields + counts) as GET reads.
      // Hand-rolled inline mapping was missing fields and would drift.
      const mapped = cloudProject ? mapCloudProject(cloudProject) : null;
      res.json(success(
        {
          project: mapped,
          current_project_id,
          current_project_state: 'stored' as CurrentProjectState,
        },
        'project_set_current',
        (req as any).requestId,
      ));
    } catch (err: any) {
      sendProxyError(res, req, err, 'project_set_current');
    }
  });

  // POST /v1/projects — CREATE retired (lives on idealvibe).
  router.post('/', (req: Request, res: Response) => {
    res.status(410).json(error(
      'GONE',
      'Project create lives on idealvibe.online/dashboard/projects — ACP is read+switch only in Phase 1',
      'project_create',
      (req as any).requestId,
    ));
  });

  // PATCH /v1/projects/:id — UPDATE retired (Phase 1 uses PUT, not PATCH).
  router.patch('/:id', (req: Request, res: Response) => {
    res.status(410).json(error(
      'GONE',
      'Project update uses PUT /v1/projects/:id (not PATCH) — see Wave A.1 contract',
      'project_update',
      (req as any).requestId,
    ));
  });

  // DELETE /v1/projects/:id — DELETE retired.
  router.delete('/:id', (req: Request, res: Response) => {
    res.status(410).json(error(
      'GONE',
      'Project delete lives on idealvibe.online/dashboard/projects — ACP is read+switch only in Phase 1',
      'project_delete',
      (req as any).requestId,
    ));
  });

  // PUT /v1/projects/:id — proxy project-attribute writeback to cloud.
  // Body subset of: name, description, is_active, runtime, target_stack,
  // auth_method, repo_path, goal_summary, app_type, signin_choice,
  // runtime_choice, repo_layout, stack_topology, compliance, advisor_output.
  // Cloud validates enum CHECK constraints (400 INVALID_RUNTIME / etc) and
  // owner-or-admin authz (403 PROJECT_FORBIDDEN). Field-omit = keep current.
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const session = getSession();
      if (!session) throw new NotAuthenticatedError();
      const userId = session.userId || '0';
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', 'project_put', (req as any).requestId));
        return;
      }

      const { status, payload } = await callCloud(cfg, 'PUT', `${CLOUD_PROJECTS_PATH}/${id}`, undefined, req.body || {});

      // Pass cloud error codes through with their original HTTP status —
      // FE switches on the real validation / authz / not-found distinctions.
      if (status === 400 || status === 403 || status === 404) {
        const upstreamError = (payload as any)?.error ?? {};
        const code = upstreamError.code || (status === 400 ? 'BAD_REQUEST' : status === 403 ? 'PROJECT_FORBIDDEN' : 'PROJECT_NOT_FOUND');
        const message = upstreamError.message || `Cloud returned HTTP ${status}`;
        res.status(status).json(error(code, message, 'project_put', (req as any).requestId));
        return;
      }
      if (status < 200 || status >= 300 || !(payload as any)?.success) {
        const upstreamMsg = (payload as any)?.error?.message || `Cloud returned HTTP ${status}`;
        res.status(502).json(error('PROXY_ERROR', upstreamMsg, 'project_put', (req as any).requestId));
        return;
      }

      // Invalidate caches that may reflect this project's pre-edit state.
      // - list: editor's project list shape may have changed (name/desc/is_active)
      // - current: editor's pointer may be at this project; defensive clear
      // - team: project-wide team_member_count or related counts may shift;
      //   clear globally for this project_id
      cache.list.clear(userId);
      cache.current.clear(userId);
      cache.team.clear(undefined, id);

      const data = (payload as any).data ?? {};
      const cloudProject = data.project ?? data;
      const mapped = cloudProject && typeof cloudProject === 'object' && cloudProject.id
        ? mapCloudProject(cloudProject)
        : null;

      res.json(success({ project: mapped }, 'project_put', (req as any).requestId));
    } catch (err: any) {
      sendProxyError(res, req, err, 'project_put');
    }
  });

  // GET /v1/projects/:id/team — proxy agent-team roster.
  // Returns ProjectTeamMemberDto[] ordered by `is_lead DESC, agent_name ASC`
  // (server-side per DotNetPert msg 987). 60s soft cache keyed by user:project.
  router.get('/:id/team', async (req: Request, res: Response) => {
    try {
      const session = getSession();
      if (!session) throw new NotAuthenticatedError();
      const userId = session.userId || '0';
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', 'project_team_get', (req as any).requestId));
        return;
      }
      const forceRefreshFlag = String(req.query.force_refresh || '') === 'true';

      if (!forceRefreshFlag) {
        const fresh = cache.team.getFresh(userId, id);
        if (fresh) {
          res.json(success({ project_id: fresh.project_id, team: fresh.team, source: 'cache', fetchedAt: fresh.fetchedAt }, 'project_team_get', (req as any).requestId));
          return;
        }
      }

      try {
        const { status, payload } = await callCloud(cfg, 'GET', `${CLOUD_PROJECTS_PATH}/${id}/team`);
        if (status === 403) {
          res.status(403).json(error('PROJECT_FORBIDDEN', 'Cross-tenant or non-member project access denied', 'project_team_get', (req as any).requestId));
          return;
        }
        if (status === 404) {
          res.status(404).json(error('NOT_FOUND', 'Project not found', 'project_team_get', (req as any).requestId));
          return;
        }
        if (status < 200 || status >= 300 || !(payload as any)?.success) {
          // Stale-cache fallback on non-2xx
          const stale = cache.team.getStale(userId, id);
          if (stale) {
            res.json(success({
              project_id: stale.project_id,
              team: stale.team,
              source: 'cache',
              fetchedAt: stale.fetchedAt,
              warning: `Cloud returned HTTP ${status}; serving last-known team`,
            }, 'project_team_get', (req as any).requestId));
            return;
          }
          const upstreamMsg = (payload as any)?.error?.message || `Cloud returned HTTP ${status}`;
          res.status(502).json(error('PROXY_ERROR', upstreamMsg, 'project_team_get', (req as any).requestId));
          return;
        }

        const { project_id, team } = extractAndMapTeam(payload);
        const entry = cache.team.set(userId, id, team);
        res.json(success({
          project_id: project_id ?? id,
          team: entry.team,
          source: 'cloud',
          fetchedAt: entry.fetchedAt,
        }, 'project_team_get', (req as any).requestId));
      } catch (err: any) {
        if (err instanceof NotAuthenticatedError) throw err;
        const stale = cache.team.getStale(userId, id);
        const reason = err?.name === 'AbortError' ? 'Cloud unreachable (timeout)' : `Cloud unreachable (${err?.message || 'error'})`;
        if (stale) {
          res.json(success({
            project_id: stale.project_id,
            team: stale.team,
            source: 'cache',
            fetchedAt: stale.fetchedAt,
            warning: `${reason}; serving last-known team`,
          }, 'project_team_get', (req as any).requestId));
          return;
        }
        throw err;
      }
    } catch (err: any) {
      sendProxyError(res, req, err, 'project_team_get');
    }
  });

  // PUT /v1/projects/:id/team/:agent_id — proxy team-member override
  // writeback. Body subset of: role, runtime_override, work_dir_override,
  // position_hint, is_lead. Cloud validates enums (400 INVALID_RUNTIME /
  // INVALID_POSITION_HINT) and owner-or-admin authz (403). Field-omit +
  // explicit-null both = keep current per DotNetPert msg 987.
  router.put('/:id/team/:agent_id', async (req: Request, res: Response) => {
    try {
      const session = getSession();
      if (!session) throw new NotAuthenticatedError();
      const id = parseInt(req.params.id as string, 10);
      const agentId = parseInt(req.params.agent_id as string, 10);
      if (isNaN(id) || isNaN(agentId)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id and agent_id must be integers', 'project_team_put', (req as any).requestId));
        return;
      }

      const { status, payload } = await callCloud(cfg, 'PUT', `${CLOUD_PROJECTS_PATH}/${id}/team/${agentId}`, undefined, req.body || {});

      if (status === 400 || status === 403 || status === 404) {
        const upstreamError = (payload as any)?.error ?? {};
        const code = upstreamError.code || (status === 400 ? 'BAD_REQUEST' : status === 403 ? 'PROJECT_FORBIDDEN' : 'NOT_FOUND');
        const message = upstreamError.message || `Cloud returned HTTP ${status}`;
        res.status(status).json(error(code, message, 'project_team_put', (req as any).requestId));
        return;
      }
      if (status < 200 || status >= 300 || !(payload as any)?.success) {
        const upstreamMsg = (payload as any)?.error?.message || `Cloud returned HTTP ${status}`;
        res.status(502).json(error('PROXY_ERROR', upstreamMsg, 'project_team_put', (req as any).requestId));
        return;
      }

      // Team membership shape changed for this project — clear all cached
      // copies (any user who fetched this project's team has stale data).
      cache.team.clear(undefined, id);

      const teamMember = extractTeamMemberEcho(payload);
      res.json(success({ team_member: teamMember }, 'project_team_put', (req as any).requestId));
    } catch (err: any) {
      sendProxyError(res, req, err, 'project_team_put');
    }
  });

  // POST /v1/projects/:id/team — add agent to project's team. Body
  // `{ agent_id }`. Mirrors DotNetPert msg 1078 cloud surface (image
  // f7045b2ff2df on vibe-publicapi_rosa:32786). Vital-thing add path
  // for idealvibe-web's TeamMembershipModal; acp-desktop currently
  // read-only via Ship D drawer but proxy lives here for desktop-side
  // parity (Wave C/D may consume).
  //   201 → { team_member }
  //   409 ALREADY_MEMBER if agent_id already on team
  //   404 AGENT_NOT_FOUND if agent_id doesn't exist in canonical roster
  //   400 VALIDATION_ERROR on missing/non-integer agent_id
  //   403 PROJECT_FORBIDDEN for non-owner/admin callers
  router.post('/:id/team', async (req: Request, res: Response) => {
    try {
      const session = getSession();
      if (!session) throw new NotAuthenticatedError();
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', 'project_team_post', (req as any).requestId));
        return;
      }
      const agentId = (req.body || {}).agent_id;
      if (typeof agentId !== 'number' || !Number.isFinite(agentId)) {
        res.status(400).json(error('VALIDATION_ERROR', 'agent_id (integer) is required in body', 'project_team_post', (req as any).requestId));
        return;
      }

      const { status, payload } = await callCloud(cfg, 'POST', `${CLOUD_PROJECTS_PATH}/${id}/team`, undefined, { agent_id: agentId });

      if (status === 400 || status === 403 || status === 404 || status === 409) {
        const upstreamError = (payload as any)?.error ?? {};
        const code = upstreamError.code
          || (status === 400 ? 'VALIDATION_ERROR'
            : status === 403 ? 'PROJECT_FORBIDDEN'
            : status === 404 ? 'AGENT_NOT_FOUND'
            : 'ALREADY_MEMBER');
        const message = upstreamError.message || `Cloud returned HTTP ${status}`;
        res.status(status).json(error(code, message, 'project_team_post', (req as any).requestId));
        return;
      }
      if (status < 200 || status >= 300 || !(payload as any)?.success) {
        const upstreamMsg = (payload as any)?.error?.message || `Cloud returned HTTP ${status}`;
        res.status(502).json(error('PROXY_ERROR', upstreamMsg, 'project_team_post', (req as any).requestId));
        return;
      }

      // Team membership shape changed project-wide — invalidate all cached
      // team rosters for this project_id so the next GET fetches fresh.
      cache.team.clear(undefined, id);

      const teamMember = extractTeamMemberEcho(payload);
      res.status(201).json(success({ team_member: teamMember }, 'project_team_post', (req as any).requestId));
    } catch (err: any) {
      sendProxyError(res, req, err, 'project_team_post');
    }
  });

  // DELETE /v1/projects/:id/team/:agent_id — remove agent from project.
  // Cloud msg 1078 + msg 1080:
  //   204 (empty)
  //   400 CANNOT_REMOVE_LEAD if is_lead=true (FE pre-disables remove button
  //                          for lead, this is the backstop)
  //   404 NOT_ON_TEAM if agent isn't a current member
  //   403 PROJECT_FORBIDDEN for non-owner/admin
  router.delete('/:id/team/:agent_id', async (req: Request, res: Response) => {
    try {
      const session = getSession();
      if (!session) throw new NotAuthenticatedError();
      const id = parseInt(req.params.id as string, 10);
      const agentId = parseInt(req.params.agent_id as string, 10);
      if (isNaN(id) || isNaN(agentId)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id and agent_id must be integers', 'project_team_delete', (req as any).requestId));
        return;
      }

      const { status, payload } = await callCloud(cfg, 'DELETE', `${CLOUD_PROJECTS_PATH}/${id}/team/${agentId}`);

      if (status === 400 || status === 403 || status === 404) {
        const upstreamError = (payload as any)?.error ?? {};
        const code = upstreamError.code
          || (status === 400 ? 'CANNOT_REMOVE_LEAD'
            : status === 403 ? 'PROJECT_FORBIDDEN'
            : 'NOT_ON_TEAM');
        const message = upstreamError.message || `Cloud returned HTTP ${status}`;
        res.status(status).json(error(code, message, 'project_team_delete', (req as any).requestId));
        return;
      }
      // 204 No Content is also success — callCloud normalizes to status 204
      // with null payload. Treat both 2xx + payload-may-be-null as success.
      if (status < 200 || status >= 300) {
        const upstreamMsg = (payload as any)?.error?.message || `Cloud returned HTTP ${status}`;
        res.status(502).json(error('PROXY_ERROR', upstreamMsg, 'project_team_delete', (req as any).requestId));
        return;
      }

      // Team membership shape changed project-wide — invalidate caches.
      cache.team.clear(undefined, id);

      res.status(200).json(success({}, 'project_team_delete', (req as any).requestId));
    } catch (err: any) {
      sendProxyError(res, req, err, 'project_team_delete');
    }
  });

  // GET /v1/projects/:id — proxy to cloud detail (project + members).
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const session = getSession();
      if (!session) throw new NotAuthenticatedError();
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', 'project_get', (req as any).requestId));
        return;
      }
      const { status, payload } = await callCloud(cfg, 'GET', `${CLOUD_PROJECTS_PATH}/${id}`);
      if (status === 403) {
        res.status(403).json(error('PROJECT_FORBIDDEN', 'Cross-tenant or cross-user project access denied', 'project_get', (req as any).requestId));
        return;
      }
      if (status === 404) {
        res.status(404).json(error('NOT_FOUND', 'Project not found', 'project_get', (req as any).requestId));
        return;
      }
      if (status < 200 || status >= 300 || !(payload as any)?.success) {
        const upstreamMsg = (payload as any)?.error?.message || `Cloud returned HTTP ${status}`;
        res.status(502).json(error('PROXY_ERROR', upstreamMsg, 'project_get', (req as any).requestId));
        return;
      }
      const detail = extractAndMapDetail(payload);
      res.json(success(detail, 'project_get', (req as any).requestId));
    } catch (err: any) {
      sendProxyError(res, req, err, 'project_get');
    }
  });

  // GET /v1/projects/:id/lifecycle — proxy to cloud lifecycle state.
  // Wave C runtime poller calls this every 10s to learn state
  // transitions (INCOMPLETE/IDLE/RUNNING/PAUSED). Pass-through; cloud
  // is canonical (DotNetPert msg 1142 8ae7a6597).
  router.get('/:id/lifecycle', async (req: Request, res: Response) => {
    try {
      const session = getSession();
      if (!session) throw new NotAuthenticatedError();
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', 'project_lifecycle_get', (req as any).requestId));
        return;
      }
      const { status, payload } = await callCloud(cfg, 'GET', `${CLOUD_PROJECTS_PATH}/${id}/lifecycle`);
      if (status === 403) {
        res.status(403).json(error('PROJECT_FORBIDDEN', 'Cross-tenant or cross-user project access denied', 'project_lifecycle_get', (req as any).requestId));
        return;
      }
      if (status === 404) {
        res.status(404).json(error('NOT_FOUND', 'Project not found', 'project_lifecycle_get', (req as any).requestId));
        return;
      }
      if (status < 200 || status >= 300 || !(payload as any)?.success) {
        const upstreamMsg = (payload as any)?.error?.message || `Cloud returned HTTP ${status}`;
        res.status(502).json(error('PROXY_ERROR', upstreamMsg, 'project_lifecycle_get', (req as any).requestId));
        return;
      }
      res.json(success((payload as any).data ?? payload, 'project_lifecycle_get', (req as any).requestId));
    } catch (err: any) {
      sendProxyError(res, req, err, 'project_lifecycle_get');
    }
  });

  // POST /v1/projects/:id/lifecycle — proxy to cloud state machine
  // (start / pause / restart). Body `{action}`. Wave C state machine
  // gates on 8-cond predicate; surfaces INVALID_TRANSITION /
  // INCOMPLETE_PROJECT errors verbatim. Used by main process when
  // user triggers Start fleet via renderer IPC.
  router.post('/:id/lifecycle', async (req: Request, res: Response) => {
    try {
      const session = getSession();
      if (!session) throw new NotAuthenticatedError();
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', 'project_lifecycle_post', (req as any).requestId));
        return;
      }
      const action = (req.body || {}).action;
      if (action !== 'start' && action !== 'pause' && action !== 'restart') {
        res.status(400).json(error('VALIDATION_ERROR', "action must be 'start' | 'pause' | 'restart'", 'project_lifecycle_post', (req as any).requestId));
        return;
      }
      const { status, payload } = await callCloud(cfg, 'POST', `${CLOUD_PROJECTS_PATH}/${id}/lifecycle`, undefined, { action });
      if (status === 403) {
        res.status(403).json(error('PROJECT_FORBIDDEN', 'Cross-tenant or cross-user project access denied', 'project_lifecycle_post', (req as any).requestId));
        return;
      }
      if (status === 404) {
        res.status(404).json(error('NOT_FOUND', 'Project not found', 'project_lifecycle_post', (req as any).requestId));
        return;
      }
      if (status === 400) {
        const code = (payload as any)?.error?.code || 'VALIDATION_ERROR';
        const msg = (payload as any)?.error?.message || 'Lifecycle action rejected';
        res.status(400).json(error(code, msg, 'project_lifecycle_post', (req as any).requestId));
        return;
      }
      if (status < 200 || status >= 300 || !(payload as any)?.success) {
        const upstreamMsg = (payload as any)?.error?.message || `Cloud returned HTTP ${status}`;
        res.status(502).json(error('PROXY_ERROR', upstreamMsg, 'project_lifecycle_post', (req as any).requestId));
        return;
      }
      res.json(success((payload as any).data ?? payload, 'project_lifecycle_post', (req as any).requestId));
    } catch (err: any) {
      sendProxyError(res, req, err, 'project_lifecycle_post');
    }
  });

  // ── Standup Rounds (#120) — proxy the project-nested durable-rounds surface
  // to cloud (PayEz-Core StandupRoundsController). The cockpit reads the round +
  // its reports[] in one shot for the W4 check-in board. Cloud bodies are
  // FE-shaped ({round}/{rounds}/{schedule}) — they may or may not carry the
  // {success,data} envelope, so we gate on HTTP status (+ an explicit
  // success===false) and forward `payload.data ?? payload` verbatim. This makes
  // the StandupRoundsController's "the acp-api sidecar proxies this verbatim"
  // comment actually true (it described intent; the route didn't exist).
  // NOTE: report-FILING (POST .../report) is the agent skill's path — it needs
  // X-ACP-Agent identity forwarding which this bearer proxy doesn't do, and the
  // desktop board is observe-only — so it is intentionally NOT proxied here.
  const proxyStandup = (
    method: 'GET' | 'POST' | 'PUT',
    matchPath: string,
    op: string,
    buildCloudPath: (id: number, req: Request) => string,
    getQuery?: (req: Request) => Record<string, unknown> | undefined,
    getBody?: (req: Request) => unknown,
  ) => {
    const handler = async (req: Request, res: Response) => {
      try {
        const session = getSession();
        if (!session) throw new NotAuthenticatedError();
        const id = parseInt(req.params.id as string, 10);
        if (isNaN(id)) {
          res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', op, (req as any).requestId));
          return;
        }
        const { status, payload } = await callCloud(
          cfg, method, buildCloudPath(id, req),
          getQuery?.(req), getBody?.(req),
        );
        // VERBATIM passthrough — these endpoints are FE-shaped ({round}/{rounds}/
        // {schedule}) and the board reads them directly (matches the controller's
        // "proxies this verbatim" contract + the running sidecar's existing
        // behavior). Forward the cloud status + body unwrapped, NOT the acp-api
        // {success,data} envelope, so callers see one stable shape live-or-built.
        res.status(status).json(payload);
      } catch (err: any) {
        sendProxyError(res, req, err, op);
      }
    };
    if (method === 'GET') router.get(matchPath, handler);
    else if (method === 'POST') router.post(matchPath, handler);
    else router.put(matchPath, handler);
  };

  const STANDUP = (id: number) => `${CLOUD_PROJECTS_PATH}/${id}/standup`;
  // Reads (the board): current open round, history list, one round.
  proxyStandup('GET', '/:id/standup/rounds/current', 'project_standup_round_current',
    (id) => `${STANDUP(id)}/rounds/current`);
  proxyStandup('GET', '/:id/standup/rounds', 'project_standup_rounds_list',
    (id) => `${STANDUP(id)}/rounds`, (req) => ({ status: req.query.status }));
  proxyStandup('GET', '/:id/standup/rounds/:roundId', 'project_standup_round_get',
    (id, req) => `${STANDUP(id)}/rounds/${parseInt(req.params.roundId as string, 10)}`);
  // Human cockpit actions: call standup (open) + close.
  proxyStandup('POST', '/:id/standup/rounds', 'project_standup_round_open',
    (id) => `${STANDUP(id)}/rounds`, undefined, (req) => req.body || {});
  proxyStandup('POST', '/:id/standup/rounds/:roundId/close', 'project_standup_round_close',
    (id, req) => `${STANDUP(id)}/rounds/${parseInt(req.params.roundId as string, 10)}/close`);
  // Durable schedule (out of localStorage, #69).
  proxyStandup('GET', '/:id/standup/schedule', 'project_standup_schedule_get',
    (id) => `${STANDUP(id)}/schedule`);
  proxyStandup('PUT', '/:id/standup/schedule', 'project_standup_schedule_set',
    (id) => `${STANDUP(id)}/schedule`, undefined, (req) => req.body || {});

  // GET /v1/projects/:id/boot-prompt/:agent_id — proxy to cloud Wave D
  // boot-prompt assembly. Returns `{template_version, project_id,
  // agent_id, agent_name, boot_prompt, assembled_at}`. The boot_prompt
  // is the system prompt passed verbatim to the LLM on spawn.
  router.get('/:id/boot-prompt/:agent_id', async (req: Request, res: Response) => {
    try {
      const session = getSession();
      if (!session) throw new NotAuthenticatedError();
      const id = parseInt(req.params.id as string, 10);
      const agentId = parseInt(req.params.agent_id as string, 10);
      if (isNaN(id) || isNaN(agentId)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id and agent_id must be integers', 'project_boot_prompt_get', (req as any).requestId));
        return;
      }
      const { status, payload } = await callCloud(cfg, 'GET', `${CLOUD_PROJECTS_PATH}/${id}/boot-prompt/${agentId}`);
      if (status === 403) {
        res.status(403).json(error('FORBIDDEN', 'Access denied', 'project_boot_prompt_get', (req as any).requestId));
        return;
      }
      if (status === 404) {
        const code = (payload as any)?.error?.code || 'NOT_FOUND';
        const msg = (payload as any)?.error?.message || 'Project or agent not on team';
        res.status(404).json(error(code, msg, 'project_boot_prompt_get', (req as any).requestId));
        return;
      }
      if (status < 200 || status >= 300 || !(payload as any)?.success) {
        const upstreamMsg = (payload as any)?.error?.message || `Cloud returned HTTP ${status}`;
        res.status(502).json(error('PROXY_ERROR', upstreamMsg, 'project_boot_prompt_get', (req as any).requestId));
        return;
      }
      res.json(success((payload as any).data ?? payload, 'project_boot_prompt_get', (req as any).requestId));
    } catch (err: any) {
      sendProxyError(res, req, err, 'project_boot_prompt_get');
    }
  });

  return router;
}
