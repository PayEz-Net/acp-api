import { Router, type Request, type Response } from 'express';
import { error } from '../response.js';
import type { Config } from '../../config.js';
import type { ContractorService } from '../contractors/service.js';
import type { SessionManager } from '../contractors/sessionManager.js';
import { ensureValidToken, forceRefresh, getSession, requireTokenClientId } from '../auth/tokenManager.js';
import * as projectsCache from '../projects/cache.js';

const AGENTMAIL_BASE = '/v1/agentmail';
const PROXY_TIMEOUT_MS = 10_000;

export class NotAuthenticatedError extends Error {
  constructor() {
    super('No active IDP session — user must log in via POST /v1/auth/login');
    this.name = 'NotAuthenticatedError';
  }
}

// Decision-C: Bearer-only (no Vibe HMAC secret in the user-session build). The
// cloud accepts a validated IDP Bearer with a client_id claim in lieu of HMAC.
// X-Client-Id mirrors the BEARER'S OWN client_id (the user's tenant), not a
// build-time constant — see requireTokenClientId. The old hardcoded idealvibe
// client (9) 401'd every beta tenant (e.g. 46) at the Vibe admin gate.
function buildAuthHeaders(_cfg: Config, token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'X-Client-Id': requireTokenClientId(token),
    'X-Vibe-Via': 'idp-proxy',
    'Content-Type': 'application/json',
  };
}

/**
 * Resolve the active session's current project_id from acp-api's projects
 * cache. Server-derived from the same source LifecycleHub on the desktop uses
 * (GET /v1/projects/current → `cache.current`), so the sidecar's view stays
 * lock-step with the renderer's.
 *
 * Used by all mail proxy routes to stamp `project_id` on every upstream call.
 * The cloud enforces project-scoped isolation (WO-agent-mail-project-isolation
 * §Sidecar + §Cloud). Both read and write paths carry the parameter so the
 * .NET backend can filter inbox, messages, search, and sidebar by project.
 *
 * Prefer fresh (60s TTL); fall back to stale for resilience inside a desktop
 * session. Project switches always relaunch the app (project-switch.ts), so a
 * stale entry within a single session is identical to fresh by construction.
 * Returns null when no session or no cached current — the call site logs and
 * forwards without project_id; the cloud will respond per its enforcement
 * policy (400 if client-supplied is required, 401/403 if server-derived).
 */
function resolveCurrentProjectId(): number | null {
  const session = getSession();
  if (!session?.userId) return null;
  const entry = projectsCache.current.getFresh(session.userId)
    ?? projectsCache.current.getStale(session.userId);
  return entry?.current_project_id ?? null;
}

/**
 * Forwards query parameters from the incoming request as a URL query string.
 */
function buildQueryString(query: Record<string, any>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Proxies a request to idealvibe.online agentmail API with auth headers.
 * Includes a 10s timeout via AbortController to prevent hanging.
 */
async function proxyToCloud(
  cfg: Config,
  path: string,
  method: 'GET' | 'POST',
  query?: Record<string, any>,
  body?: unknown
): Promise<{ status: number; data: unknown }> {
  const qs = query ? buildQueryString(query) : '';
  const url = `${cfg.vibeApiUrl}${AGENTMAIL_BASE}${path}${qs}`;

  let token = await ensureValidToken(cfg.idpUrl, 'ensureValidToken@mail');
  if (!token) {
    throw new NotAuthenticatedError();
  }


  const doFetch = async (bearer: string): Promise<{ status: number; data: unknown }> => {
    const headers = buildAuthHeaders(cfg, bearer);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    try {
      const opts: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };
      if (body && method === 'POST') {
        opts.body = JSON.stringify(body);
      }
      const res = await fetch(url, opts);
      const text = await res.text();
      if (!text) {
        return {
          status: res.status,
          data: { success: res.ok, data: null },
        };
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

  const refreshed = await forceRefresh(cfg.idpUrl, 'forceRefresh-on-401@mail');
  if (!refreshed) {
    throw new NotAuthenticatedError();
  }
  return doFetch(refreshed);
}

type MailSentCallback = (fromAgent: string, subject: string, toAgents: string[]) => void;

function sendProxyError(res: Response, req: Request, err: any, operation: string): void {
  if (err instanceof NotAuthenticatedError) {
    res.status(401).json(
      error('NOT_AUTHENTICATED', err.message, operation, (req as any).requestId)
    );
    return;
  }
  const msg = err.name === 'AbortError' ? 'Upstream timeout (10s)' : err.message;
  res.status(502).json(
    error('PROXY_ERROR', `Mail proxy failed: ${msg}`, operation, (req as any).requestId)
  );
}

export default function mailProxyRoutes(
  cfg: Config,
  onMailSent?: MailSentCallback,
  contractorService?: ContractorService,
  sessionManager?: SessionManager,
): Router {
  const router = Router();

  // GET /v1/mail/inbox/:agent -> idealvibe.online/v1/agentmail/inbox/:agent
  // WO-agent-mail-project-isolation: stamp project_id from session cache so
  // the cloud filters inbox to the active project only.
  router.get('/inbox/:agent', async (req: Request, res: Response) => {
    try {
      const projectId = resolveCurrentProjectId();
      const query: Record<string, any> = { ...(req.query as Record<string, any>) };
      if (projectId != null) {
        query.project_id = projectId;
      } else {
        console.warn(`[mailProxy] GET /inbox/${req.params.agent}: no current_project_id in cache — forwarding without project filter`);
      }
      const result = await proxyToCloud(cfg, `/inbox/${req.params.agent}`, 'GET', query);

      // TEMP-SHIM(agent-identity-overhaul): the cloud agent registry is mid-rebuild.
      // Inbox identity resolves over (vibe_agents/agent_profiles ∪
      // vibe_projects.team_agent_instances) BY NAME, so known-broken seed data makes
      // some roster agents 404 (name no longer resolves) or 403 (owned by another
      // user / not shared). That's a DATA problem being fixed in the idealvibe
      // teams/agents/projects overhaul, not a transport error — so for the read-only
      // inbox POLL we downgrade those two statuses to an empty inbox instead of
      // spamming the cockpit. NOT a silent soften: the real upstream status is logged
      // every poll. 401 (auth) and real failures (5xx/502) still pass through.
      // Remove this whole block when the overhaul lands. grep: TEMP-SHIM(agent-identity-overhaul)
      if (result.status === 403 || result.status === 404) {
        const upstreamErr = (result.data as any)?.error;
        console.warn(
          `[mailProxy] TEMP-SHIM inbox/${req.params.agent}: upstream ${result.status} ` +
          `(${upstreamErr?.code ?? '?'}: ${upstreamErr?.message ?? 'n/a'}) — returning empty inbox ` +
          `until agent-identity overhaul lands`,
        );
        res.status(200).json({ success: true, data: { messages: [], unread_count: 0 } });
        return;
      }

      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'mail_inbox');
    }
  });

  // GET /v1/mail/inboxes?agents=a,b,c -> ONE response carrying every agent's inbox.
  // P0 (Jon 2026-06-13): the renderer's fetchAllInboxes did Promise.all(agents.map(GET /inbox/:agent)),
  // an N-request CLIENT fan-out fired by 5 stacking triggers (poll/focus/mount/every-SSE-event/post-read)
  // that burst past the acp-api rate limiter -> 429 -> EVERY inbox failed at once -> team comms lockup.
  // This collapses the client to a SINGLE request; the sidecar fans out to the cloud with BOUNDED
  // concurrency (gentle upstream). Per-agent failures are ISOLATED — one agent's 4xx/5xx/timeout is
  // recorded against that agent and never drops the others or fails the batch (QA 6751 axis-2:
  // "returns EVERY inbox the x5 fan-out did, no agent lost"). Same project_id stamping + the same
  // TEMP-SHIM(agent-identity-overhaul) 403/404->empty downgrade as GET /inbox/:agent, applied per agent.
  // Response: { success, data: { inboxes: { [agent]: { messages, unread_count, error? } } } }.
  router.get('/inboxes', async (req: Request, res: Response) => {
    try {
      const raw = (req.query.agents as string | undefined) ?? '';
      const requested = raw.split(',').map((a) => a.trim()).filter((a) => a.length > 0);
      if (requested.length === 0) {
        res.status(400).json(
          error('VALIDATION_ERROR', 'agents query param is required (comma-separated agent names)', 'mail_inboxes', (req as any).requestId)
        );
        return;
      }
      // De-dupe so a roster with repeats can't multiply the upstream calls.
      const agents = [...new Set(requested)];

      const projectId = resolveCurrentProjectId();
      const baseQuery: Record<string, any> = { ...(req.query as Record<string, any>) };
      delete baseQuery.agents;                       // the agent list is ours, not an upstream inbox param
      if (projectId != null) {
        baseQuery.project_id = projectId;
      } else {
        console.warn('[mailProxy] GET /inboxes: no current_project_id in cache — forwarding without project filter');
      }

      type InboxEntry = { messages: unknown[]; unread_count: number; error?: { code: string; message: string } };
      const inboxes: Record<string, InboxEntry> = {};

      // Bounded-concurrency worker pool (NOT Promise.all of N) — predictable, gentle upstream.
      const CONCURRENCY = 4;
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < agents.length) {
          const agent = agents[cursor++];
          try {
            const result = await proxyToCloud(cfg, `/inbox/${encodeURIComponent(agent)}`, 'GET', baseQuery);

            // TEMP-SHIM(agent-identity-overhaul): identical to GET /inbox/:agent — a 403/404 from the
            // mid-rebuild cloud agent registry is a DATA problem, not transport; downgrade to empty inbox
            // (real status logged). Remove with the single-route shim. grep: TEMP-SHIM(agent-identity-overhaul)
            if (result.status === 403 || result.status === 404) {
              const upstreamErr = (result.data as any)?.error;
              console.warn(
                `[mailProxy] TEMP-SHIM inboxes/${agent}: upstream ${result.status} ` +
                `(${upstreamErr?.code ?? '?'}: ${upstreamErr?.message ?? 'n/a'}) — returning empty inbox`,
              );
              inboxes[agent] = { messages: [], unread_count: 0 };
              continue;
            }

            if (result.status >= 200 && result.status < 300) {
              const data = (result.data as any)?.data ?? {};
              inboxes[agent] = {
                messages: Array.isArray(data.messages) ? data.messages : [],
                unread_count: typeof data.unread_count === 'number' ? data.unread_count : 0,
              };
            } else {
              // Per-agent failure — record it, keep the batch (no agent lost).
              const upstreamErr = (result.data as any)?.error;
              inboxes[agent] = {
                messages: [],
                unread_count: 0,
                error: {
                  code: upstreamErr?.code ?? `UPSTREAM_${result.status}`,
                  message: upstreamErr?.message ?? `Upstream HTTP ${result.status}`,
                },
              };
            }
          } catch (e: any) {
            // A dead session is whole-request fatal (consistent with the single inbox route); let it bubble.
            if (e instanceof NotAuthenticatedError) throw e;
            inboxes[agent] = {
              messages: [],
              unread_count: 0,
              error: { code: 'PROXY_ERROR', message: e?.name === 'AbortError' ? 'Upstream timeout (10s)' : (e?.message ?? 'proxy error') },
            };
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, agents.length) }, () => worker()));

      res.status(200).json({ success: true, data: { inboxes } });
    } catch (err: any) {
      sendProxyError(res, req, err, 'mail_inboxes');
    }
  });

  // GET /v1/mail/messages/:message_id -> idealvibe.online/v1/agentmail/messages/:message_id
  router.get('/messages/:message_id', async (req: Request, res: Response) => {
    try {
      const projectId = resolveCurrentProjectId();
      const query: Record<string, any> = { ...(req.query as Record<string, any>) };
      if (projectId != null) {
        query.project_id = projectId;
      }
      const result = await proxyToCloud(cfg, `/messages/${req.params.message_id}`, 'GET', query);

      // Strip experimental ActionPanel fields that never shipped (BAPert 1369).
      // The actions array was an adopted spec that didn't get functional UI
      // support; agents see them in JSON but can't execute them. Remove so
      // clients don't display broken action hints.
      const data = result.data as any;
      if (data && typeof data === 'object') {
        if (data.data && typeof data.data === 'object') {
          delete data.data.actions;
          delete data.data.suggested;
          delete data.data.context;
        }
        delete data.actions;
        delete data.suggested;
        delete data.context;
      }

      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'mail_read');
    }
  });

  // POST /v1/mail/send -> idealvibe.online/v1/agentmail/send
  // v2: Validates recipients (no more hiring side-effect — use POST /v1/contractors/hire)
  // WO-agent-mail-project-isolation §Sidecar: stamp project_id from session's
  // cached current-project before forwarding. Cloud-side enforces.
  router.post('/send', async (req: Request, res: Response) => {
    try {
      const { from_agent, to, subject } = req.body || {};

      // Basic input validation before any upstream call
      if (!from_agent || typeof from_agent !== 'string' || from_agent.trim().length === 0) {
        res.status(400).json(
          error('VALIDATION_ERROR', 'from_agent is required and must be a non-empty string', 'mail_send', (req as any).requestId)
        );
        return;
      }
      if (!Array.isArray(to) || to.length === 0 || to.some((r: any) => typeof r !== 'string' || r.trim().length === 0)) {
        res.status(400).json(
          error('VALIDATION_ERROR', 'to must be a non-empty array of non-empty string recipient names', 'mail_send', (req as any).requestId)
        );
        return;
      }

      // v2: validate recipients — reject unknown names (AC-11), pass existing agents (AC-12)
      if (contractorService) {
        for (const recipientName of to) {
          const result = await contractorService.resolveRecipient(from_agent, recipientName);
          if (result.action === 'rejected') {
            res.status(404).json(
              error('UNKNOWN_RECIPIENT', result.error!, 'mail_send', (req as any).requestId)
            );
            return;
          }
        }
      }

      // Sidecar attach (WO-agent-mail-project-isolation §Sidecar): stamp the
      // active project_id derived from acp-api's projects cache onto the
      // outgoing body. Server-derived overrides any client-supplied value
      // because the sidecar is closer to the auth boundary than the renderer.
      // Cloud-side enforcement is the final say (per WO §Cloud API).
      const projectId = resolveCurrentProjectId();
      const forwardBody: Record<string, unknown> = { ...(req.body ?? {}) };
      if (projectId != null) {
        forwardBody.project_id = projectId;
      } else {
        console.warn(
          `[mailProxy] POST /send: no current_project_id in cache — forwarding without it (cloud will enforce). from=${from_agent ?? '?'} to=${Array.isArray(to) ? to.join(',') : '?'}`,
        );
      }

      // Proxy to cloud
      const cloudResult = await proxyToCloud(cfg, '/send', 'POST', undefined, forwardBody);
      res.status(cloudResult.status).json(cloudResult.data);

      // Post-send hooks
      if ((cloudResult.data as any)?.success) {
        // DONE: auto-completion — check if sender is a contractor completing work
        if (contractorService && from_agent && subject && Array.isArray(to)) {
          try {
            await contractorService.checkDoneAutoComplete(from_agent, subject, to);
          } catch { /* non-fatal — don't break mail delivery */ }
        }
        if (onMailSent && from_agent && subject) {
          try { onMailSent(from_agent, subject, to || []); } catch { /* non-fatal */ }
        }
      }
    } catch (err: any) {
      sendProxyError(res, req, err, 'mail_send');
    }
  });

  // POST /v1/mail/inbox/:inbox_id/read -> idealvibe.online/v1/agentmail/inbox/:inbox_id/read
  router.post('/inbox/:inbox_id/read', async (req: Request, res: Response) => {
    try {
      const result = await proxyToCloud(cfg, `/inbox/${req.params.inbox_id}/read`, 'POST');
      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'mail_mark_read');
    }
  });

  // POST /v1/mail/inbox/:agent/read-all -> cloud ATOMIC bulk read-all (project-scoped).
  // Proxies straight to the cloud's single-SQL-UPDATE endpoint
  // (AgentMailController -> AgentMailService.MarkAllAsReadAsync) instead of the old per-message
  // loop. The loop fetched only inbox page-1 (first 100 unread), could time out mid-loop on the
  // 10s proxy budget, and claimed success on partial failure. The cloud does it in one round-trip,
  // no page limit, scoped agent+client+project. (Jon / BAPert msg 1310.)
  router.post('/inbox/:agent/read-all', async (req: Request, res: Response) => {
    try {
      const agentName = req.params.agent;
      const projectId = resolveCurrentProjectId();
      const query: Record<string, any> = {};
      if (projectId != null) query.project_id = projectId;   // clear ONLY the current project's mail
      const result = await proxyToCloud(cfg, `/inbox/${agentName}/read-all`, 'POST', query);
      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'mail_mark_all_read');
    }
  });

  // GET /v1/mail/agents -> idealvibe.online/v1/agentmail/agents
  router.get('/agents', async (req: Request, res: Response) => {
    try {
      const query = { ...(req.query as Record<string, any>) };
      const projectId = resolveCurrentProjectId();
      if (projectId != null && query.project_id == null) {
        query.project_id = projectId;
      }
      const result = await proxyToCloud(cfg, '/agents', 'GET', query);
      res.status(result.status).json(result.data);
    } catch (err: any) {
      sendProxyError(res, req, err, 'mail_agents');
    }
  });

  return router;
}
