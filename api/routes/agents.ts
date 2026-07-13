import { Router, type Request, type Response } from 'express';
import { success, error } from '../response.js';
import { config } from '../../config.js';
import { ensureValidToken, forceRefresh, getSession, requireTokenClientId } from '../auth/tokenManager.js';
import * as projectsCache from '../projects/cache.js';

import { fileURLToPath } from 'url';
import * as path from 'path';
import * as fs from 'fs';

// Decision-C / no-unjustified-fallback: NO dev-box default in a public build (the off-LAN
// Praveen-class hazard + the SOURCE==ARTIFACT residue gate scans for these literals). null
// when unset -> queryVibeSql hard-fails with a surfaced error. The day-one read path (profile
// lookup) already CLOUD-resolves via cloudFetch; the remaining raw queryVibeSql callers here
// are catalog-admin ops (client_id=0 global library: startup-config/activation/hire/delete/
// startup-order/capabilities/safety-rules/skills) — NOT on Praveen's per-tenant day-one path.
const VIBESQL_URL = process.env.VIBESQL_URL || null;
const VIBESQL_SECRET = process.env.VIBESQL_SECRET || null;
const PROFILE_PROXY_TIMEOUT_MS = 10_000;

// ─── Cloud profile proxy ───────────────────────────────────────────────────
//
// Legacy `vibe_agents.agents` real table was retired when the
// documents-canonical model landed (per feedback_vibe_storage_convention
// + project_vibe_agents_storage_planes). Profile data now lives in
// vibe.documents agent_profiles collection, exposed via cloud
// /v1/agents/{id}/profile. This handler proxies to cloud and maps the
// snake_case wire shape to the camelCase shape Kimi/Claude
// agent-onboarding skills consume.
//
// Cloud accepts numeric id only on /profile. For name lookups we
// resolve id first via /v1/agentmail/agents and cache the mapping
// for the process lifetime (canonical agent roster rarely changes).

const nameToIdCache = new Map<string, number>();
let nameToIdCachePopulatedAt = 0;
const NAME_TO_ID_TTL_MS = 5 * 60 * 1000; // 5 min — refresh occasionally so new agents resolve

// Decision-C: Bearer-only (no Vibe HMAC secret in the user-session build).
// X-Client-Id mirrors the bearer's own client_id (the user's tenant), not the
// retired hardcoded idealvibe client — see requireTokenClientId.
function buildCloudAuthHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'X-Client-Id': requireTokenClientId(token),
    'X-Vibe-Via': 'idp-proxy',
    'Content-Type': 'application/json',
  };
}

// Cloud fetch over the Decision-C Bearer lane. GET by default; pass method+body for the
// profile-CRUD WRITES (DnP 7286: PUT profile, POST/DELETE skills, POST repos). Same
// ensureValidToken -> Bearer + X-Client-Id path + the one 401->forceRefresh retry.
async function cloudFetch(
  signedPath: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: any } | { error: string }> {
  let token = await ensureValidToken(config.idpUrl);
  if (!token) return { error: 'NO_SESSION' };

  const method = opts.method ?? 'GET';
  const hasBody = opts.body !== undefined && method !== 'GET' && method !== 'HEAD';
  const url = `${config.vibeApiUrl}${signedPath}`;
  const doFetch = async (bearer: string) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROFILE_PROXY_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        headers: buildCloudAuthHeaders(bearer),
        body: hasBody ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let body: any = null;
      try { body = text ? JSON.parse(text) : null; } catch { /* leave null */ }
      return { status: res.status, body };
    } finally {
      clearTimeout(timeout);
    }
  };

  let attempt = await doFetch(token);
  if (attempt.status === 401) {
    const refreshed = await forceRefresh(config.idpUrl);
    if (!refreshed) return { error: 'NO_SESSION' };
    attempt = await doFetch(refreshed);
  }
  return attempt;
}

// Proxy an agent management route to its existing cloud endpoint over the Bearer lane
// (DnP 7300 map — the cloud paths mirror these routes 1:1). Replaces the raw dev-box
// queryVibeSql so the route works OFF-LAN. NO_SESSION -> 401; cloud-unreachable -> 503
// (honest surface, never a silent dev-box dial). The cloud {success,data} envelope passes
// straight through (same shape the existing acp-api success() envelope produced).
async function proxyAgentCloud(
  req: Request,
  res: Response,
  op: string,
  method: string,
  cloudPath: string,
  body?: unknown,
): Promise<void> {
  const result = await cloudFetch(cloudPath, { method, body });
  if ('error' in result) {
    const status = result.error === 'NO_SESSION' ? 401 : 503;
    const code = result.error === 'NO_SESSION' ? 'NO_SESSION' : 'UPSTREAM_UNAVAILABLE';
    res.status(status).json(error(code, `Cloud agent endpoint unreachable (${result.error})`, op, (req as any).requestId));
    return;
  }
  res.status(result.status).json(result.body);
}

function resolveCurrentProjectId(): number | null {
  const session = getSession();
  if (!session?.userId) return null;
  const entry = projectsCache.current.getFresh(session.userId)
    ?? projectsCache.current.getStale(session.userId);
  return entry?.current_project_id ?? null;
}

async function resolveAgentNameToId(name: string): Promise<number | null> {
  const cached = nameToIdCache.get(name);
  if (cached !== undefined && Date.now() - nameToIdCachePopulatedAt < NAME_TO_ID_TTL_MS) {
    return cached;
  }

  // Project-scope the roster when possible so name resolution matches the
  // project-scoped sidebar/mail view. Falls back to the full tenant roster
  // when no current project is cached.
  const projectId = resolveCurrentProjectId();
  const query = projectId != null ? `?project_id=${projectId}` : '';
  const result = await cloudFetch(`/v1/agentmail/agents${query}`);
  if ('error' in result) return null;
  if (result.status < 200 || result.status >= 300) return null;
  const agents = result.body?.data?.agents;
  if (!Array.isArray(agents)) return null;

  // Repopulate cache from this fetch — single roundtrip covers all canonical
  // agents, no point caching just the one we asked for.
  nameToIdCache.clear();
  const candidatesByName = new Map<string, Array<{ id: number; identityPrompt: string }>>();
  for (const a of agents) {
    if (a && typeof a.id === 'number' && typeof a.name === 'string') {
      const list = candidatesByName.get(a.name) ?? [];
      list.push({
        id: a.id,
        identityPrompt: typeof a.identity_prompt === 'string' ? a.identity_prompt : '',
      });
      candidatesByName.set(a.name, list);
    }
  }

  // When multiple docs share the same name (e.g. a seeded primary agent and a
  // workshop-created agent with the same name), prefer the one that actually
  // has a profile. This prevents empty-profile fallbacks caused by duplicate
  // agent rows where one has an empty identity_prompt.
  for (const [agentName, candidates] of candidatesByName.entries()) {
    const chosen = candidates.find(c => c.identityPrompt.length > 0) ?? candidates[0];
    nameToIdCache.set(agentName, chosen.id);
  }

  nameToIdCachePopulatedAt = Date.now();
  return nameToIdCache.get(name) ?? null;
}

interface CloudProfileShape {
  id?: number;
  agent_id?: number;
  identity_md?: string | null;       // ProfileDto [JsonPropertyName("identity_md")]
  role_md?: string | null;
  philosophy_md?: string | null;
  communication_md?: string | null;
  response_pattern_md?: string | null;
  expertise_json?: unknown;
  capabilities?: unknown;
  safety_rules?: unknown;
  version?: number;
}

function mapCloudProfile(
  cloudProfile: CloudProfileShape,
  meta: { name: string; displayName?: string; role?: string },
): Record<string, unknown> {
  // v1 schema collapse (Jon directive 2026-05-12): the 5-field
  // psychological breakdown (identity_md / role_md / philosophy_md /
  // communication_md / response_pattern_md) is OUT for launch. The
  // schema is `properties + one free-text profile`. Users can put
  // whatever attributes they want in the free-text profile.
  //
  // For backward-tolerance during the cloud schema cleanup, we
  // concatenate any non-empty content across the legacy fields into
  // a single `profile` paragraph blob. In practice today only
  // identity_md is populated for canonical agents — so `profile`
  // ends up = identity_md content. Order matches the original
  // breakdown sequence so any author who DID fill multiple fields
  // gets a sensible read.
  const sections = [
    cloudProfile.identity_md,
    cloudProfile.role_md,
    cloudProfile.philosophy_md,
    cloudProfile.communication_md,
    cloudProfile.response_pattern_md,
  ].filter((s): s is string => typeof s === 'string' && s.length > 0);
  const profile = sections.join('\n\n');
  return {
    name: meta.name,
    displayName: meta.displayName || meta.name,
    role: meta.role || 'agent',
    profile,
    isActive: true,
    program: 'claude-code',
    model: 'claude-sonnet-4-6',
  };
}

// ── SQL helpers ────────────────────────────────────────────────────────────

function escapeSql(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'NULL';
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function escapeJsonb(obj: unknown): string {
  return "'" + JSON.stringify(obj).replace(/'/g, "''") + "'::jsonb";
}

function toCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function rowToCamel(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const camelKey = toCamel(k);
    // Parse JSONB string fields back to arrays/objects
    if (
      (camelKey === 'expertiseJson' || camelKey === 'capabilities' || camelKey === 'safetyRules') &&
      typeof v === 'string'
    ) {
      try {
        out[camelKey] = JSON.parse(v);
      } catch {
        out[camelKey] = v;
      }
    } else {
      out[camelKey] = v;
    }
  }
  return out;
}

async function queryVibeSql(sql: string): Promise<{ success: boolean; data?: any[]; rowCount?: number; error?: any }> {
  if (!VIBESQL_URL || !VIBESQL_SECRET) {
    // Surface + halt — never silently fall back to the dev box (Decision-C). Raw /v1/query is
    // dev-only; a public install must not reach it. Day-one reads go through cloudFetch instead.
    throw new Error('VIBESQL_URL / VIBESQL_SECRET not configured — raw VibeSQL is dev-only and is not available in this build. Use the cloud typed API.');
  }
  const res = await fetch(`${VIBESQL_URL}/v1/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Secret ${VIBESQL_SECRET}`,
    },
    body: JSON.stringify({ sql }),
  });
  const data = await res.json().catch(() => ({ success: false }));
  return data;
}

// ── JWT helper ─────────────────────────────────────────────────────────────

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function getBearerEmail(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const payload = decodeJwtPayload(token);
  if (payload && typeof payload.email === 'string') return payload.email;
  return null;
}

function getBearerIdentity(req: Request): { email: string | null; sub: string | null; clientId: number | null } {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return { email: null, sub: null, clientId: null };
  const token = authHeader.slice(7);
  const payload = decodeJwtPayload(token);
  const email = payload && typeof payload.email === 'string' ? payload.email : null;
  const sub = payload && typeof payload.sub === 'string' ? payload.sub : null;
  // Some IDPs put client_id in the JWT as a string or number claim
  const clientIdClaim = payload?.client_id ?? payload?.clientId ?? payload?.tenant;
  const clientId = typeof clientIdClaim === 'number' ? clientIdClaim : typeof clientIdClaim === 'string' ? parseInt(clientIdClaim, 10) || null : null;
  return { email, sub, clientId };
}

// ── Route factory ──────────────────────────────────────────────────────────

export default function agentRoutes(_storage: any): Router {
  const router = Router();

  // GET /v1/agents/startup-config
  //
  // Canonical model: type-aware seeding (BAPert ratified 2026-05-23, #37).
  // The doc-store at client_id=0 holds the global Specialist Library catalog.
  // Core team (BA+QA) are always-on; tech specialists are stack-gated via
  // SeedTypeAwareForProjectAsync in vibe-publicapi. is_canonical is deprecated.
  //
  router.get('/startup-config', async (req: Request, res: Response) => {
    try {
      // Cloud-proxied (DnP 7300): GET /v1/agents/startup-config — was raw vsql to the dev box.
      await proxyAgentCloud(req, res, 'agent_startup_config', 'GET', '/v1/agents/startup-config');
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_startup_config', (req as any).requestId));
    }
  });

  // PATCH /v1/agents/:id/activation
  router.patch('/:id/activation', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', 'agent_activation', (req as any).requestId));
        return;
      }

      const { is_active, startup_order } = req.body || {};
      if (is_active === undefined || typeof is_active !== 'boolean') {
        res.status(400).json(error('VALIDATION_ERROR', 'is_active (boolean) is required', 'agent_activation', (req as any).requestId));
        return;
      }

      const body: Record<string, unknown> = { is_active };
      if (startup_order !== undefined) {
        const order = parseInt(startup_order, 10);
        if (isNaN(order) || order < 0) {
          res.status(400).json(error('VALIDATION_ERROR', 'startup_order must be a non-negative integer', 'agent_activation', (req as any).requestId));
          return;
        }
        body.startup_order = order;
      }
      // Cloud-proxied (DnP 7300): PATCH /v1/agents/{id}/activation — was raw vsql to the dev box.
      await proxyAgentCloud(req, res, 'agent_activation', 'PATCH', `/v1/agents/${id}/activation`, body);
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_activation', (req as any).requestId));
    }
  });

  // DELETE /v1/agents/:id — soft delete
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', 'agent_delete', (req as any).requestId));
        return;
      }

      // Cloud-proxied (DnP 7300): DELETE /v1/agents/{id} — was raw vsql to the dev box.
      await proxyAgentCloud(req, res, 'agent_delete', 'DELETE', `/v1/agents/${id}`);
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_delete', (req as any).requestId));
    }
  });

  // POST /v1/agents/hire
  router.post('/hire', async (req: Request, res: Response) => {
    try {
      const { name, display_name, is_active, role, description } = req.body || {};

      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        res.status(400).json(error('VALIDATION_ERROR', 'name is required', 'agent_hire', (req as any).requestId));
        return;
      }
      // Cloud-proxied (DnP 7303): POST /v1/agents IS the renamed /hire (live prod) — it owns
      // dup-name check + race-free id allocation + the doc insert server-side. The legacy
      // template_name / contractor_pool lookup was DROPPED per spec (won't resurrect), so we
      // forward a clean create body; the dev-box raw INSERT is gone.
      const body = {
        name: name.trim(),
        display_name: display_name || name.trim(),
        role: role || description || null,
        is_active: is_active !== undefined ? is_active : false,
      };
      await proxyAgentCloud(req, res, 'agent_hire', 'POST', '/v1/agents', body);
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_hire', (req as any).requestId));
    }
  });

  // PUT /v1/agents/startup-order
  router.put('/startup-order', async (req: Request, res: Response) => {
    try {
      const { order } = req.body || {};
      if (!Array.isArray(order) || order.length === 0) {
        res.status(400).json(error('VALIDATION_ERROR', 'order must be a non-empty array of { agent_id, startup_order }', 'agent_startup_order', (req as any).requestId));
        return;
      }

      for (const entry of order) {
        if (!entry.agent_id || isNaN(parseInt(entry.agent_id, 10))) {
          res.status(400).json(error('VALIDATION_ERROR', 'Each entry must have a valid agent_id', 'agent_startup_order', (req as any).requestId));
          return;
        }
        const so = parseInt(entry.startup_order, 10);
        if (isNaN(so) || so < 0) {
          res.status(400).json(error('VALIDATION_ERROR', 'Each entry must have a non-negative startup_order', 'agent_startup_order', (req as any).requestId));
          return;
        }
      }

      // Cloud-proxied (DnP 7300): PUT /v1/agents/startup-order — was raw vsql to the dev box.
      await proxyAgentCloud(req, res, 'agent_startup_order', 'PUT', '/v1/agents/startup-order', { order });
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_startup_order', (req as any).requestId));
    }
  });

  // PUT /v1/agents/:id/capabilities
  router.put('/:id/capabilities', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', 'agent_capabilities', (req as any).requestId));
        return;
      }
      const { capabilities } = req.body || {};
      if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
        res.status(400).json(error('VALIDATION_ERROR', 'capabilities must be an object', 'agent_capabilities', (req as any).requestId));
        return;
      }

      // Cloud-proxied (DnP 7300): PUT /v1/agents/{id}/capabilities — was raw vsql to the dev box.
      await proxyAgentCloud(req, res, 'agent_capabilities', 'PUT', `/v1/agents/${id}/capabilities`, { capabilities });
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_capabilities', (req as any).requestId));
    }
  });

  // PUT /v1/agents/:id/safety-rules
  router.put('/:id/safety-rules', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', 'agent_safety_rules', (req as any).requestId));
        return;
      }
      const { safety_rules } = req.body || {};
      if (!Array.isArray(safety_rules)) {
        res.status(400).json(error('VALIDATION_ERROR', 'safety_rules must be an array', 'agent_safety_rules', (req as any).requestId));
        return;
      }

      // Cloud-proxied (DnP 7300): PUT /v1/agents/{id}/safety-rules — was raw vsql to the dev box.
      await proxyAgentCloud(req, res, 'agent_safety_rules', 'PUT', `/v1/agents/${id}/safety-rules`, { safety_rules });
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_safety_rules', (req as any).requestId));
    }
  });

  // POST /v1/agents/init-project
  router.post('/init-project', async (req: Request, res: Response) => {
    try {
      const identity = getBearerIdentity(req);
      const email = identity.email;
      const userId = identity.sub ? parseInt(identity.sub, 10) : null;
      // Decision-C / no-unjustified-fallback: the tenant MUST come from the session
      // JWT's client_id claim — never default to a baked client number (that silently
      // provisions the project under the wrong tenant). Absent claim -> hard 401.
      const clientId = identity.clientId;
      if (clientId == null) {
        res.status(401).json(error('CLIENT_REQUIRED', 'Session JWT has no client_id (tenant) claim — cannot provision a project', 'agent_init_project', (req as any).requestId));
        return;
      }
      const { project_name, runtime_choice } = req.body || {};

      let derivedName = project_name;
      if (!derivedName) {
        if (!email) {
          res.status(400).json(error('EMAIL_REQUIRED', 'Session JWT has no email claim — provide project_name override', 'agent_init_project', (req as any).requestId));
          return;
        }
        const localPart = email.split('@')[0].toLowerCase();
        derivedName = `${localPart}-project`;
      }

      // Cloud-proxied (DnP 7300): POST /v1/projects (CreateProject) — was raw vsql across
      // vibe_projects.projects + vibe.documents to the dev box. The cloud derives owner/client
      // off the bearer and seeds the core team server-side (SeedTypeAwareForProjectAsync), so
      // the local raw INSERT + the hand-rolled BAPert/QAPert seed are GONE (no dev-box, off-LAN).
      void clientId; void userId; // identity validated above; cloud re-derives off the bearer
      await proxyAgentCloud(req, res, 'agent_init_project', 'POST', '/v1/projects', {
        name: derivedName,
        description: 'Auto-provisioned project',
        runtime_choice: runtime_choice || 'kimi',
      });
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_init_project', (req as any).requestId));
    }
  });

  // GET /v1/agents/:identifier/profile — proxies to cloud agent profile
  // doc-store (post-2026-05-12 cloud-canonical refactor).
  //
  // identifier: numeric id  → direct proxy to cloud /v1/agents/{id}/profile
  // identifier: name        → resolve name→id via cloud /v1/agentmail/agents,
  //                           then proxy
  //
  // The legacy vibe_agents.agents real table was retired with the
  // documents-canonical migration. Direct VibeSQL queries against it
  // returned `relation "vibe_agents.agents" does not exist` and the
  // handler dropped to a thin-shape fallback that broke the Kimi
  // agent-onboarding skill. Cloud has the canonical doc-store data
  // and accepts numeric id on /profile.
  router.get('/:identifier/profile', async (req: Request, res: Response) => {
    try {
      const identifier = req.params.identifier;
      if (!identifier || typeof identifier !== 'string') {
        res.status(400).json(error('VALIDATION_ERROR', 'identifier is required', 'agent_profile', (req as any).requestId));
        return;
      }

      const isNumericId = /^\d+$/.test(identifier);
      let agentId: number | null = null;
      let resolvedName = '';

      if (isNumericId) {
        agentId = parseInt(identifier, 10);
        // We don't have the name yet; lookup via cache or roster after we
        // fetch the profile. Cheaper to just include it in the mapper
        // fallback as "<id>" if roster lookup misses.
      } else {
        resolvedName = identifier;
        agentId = await resolveAgentNameToId(identifier);
        if (agentId === null) {
          console.warn(`[agent_profile] Could not resolve name "${identifier}" to id via cloud /v1/agentmail/agents — falling back to SessionManager thin shape`);
          const basic = await _storage.getAgentProfileFromGlobal(identifier);
          if (basic) {
            res.json(success(basic, 'agent_profile', (req as any).requestId));
            return;
          }
          res.status(404).json(error('NOT_FOUND', `Agent '${identifier}' not found`, 'agent_profile', (req as any).requestId));
          return;
        }
      }

      // Pull the agent metadata (name + display_name) from the cached
      // roster so the response carries the right name/display_name even
      // when only the id was on the wire.
      let displayName: string | undefined;
      if (!resolvedName && agentId !== null) {
        for (const [n, id] of nameToIdCache.entries()) {
          if (id === agentId) { resolvedName = n; break; }
        }
        if (!resolvedName) {
          // Populate the cache by force-fetching the roster.
          await resolveAgentNameToId('___populate-only___');
          for (const [n, id] of nameToIdCache.entries()) {
            if (id === agentId) { resolvedName = n; break; }
          }
        }
      }

      const profileResult = await cloudFetch(`/v1/agents/${agentId}/profile`);
      if ('error' in profileResult) {
        console.warn(`[agent_profile] Cloud unreachable for /v1/agents/${agentId}/profile (${profileResult.error}) — thin fallback`);
        const basic = await _storage.getAgentProfileFromGlobal(resolvedName || String(agentId));
        if (basic) {
          res.json(success(basic, 'agent_profile', (req as any).requestId));
          return;
        }
        res.status(503).json(error('UPSTREAM_UNAVAILABLE', `Cloud unreachable: ${profileResult.error}`, 'agent_profile', (req as any).requestId));
        return;
      }

      if (profileResult.status === 404) {
        res.status(404).json(error('NOT_FOUND', `Agent '${identifier}' not found in cloud doc-store`, 'agent_profile', (req as any).requestId));
        return;
      }

      if (profileResult.status < 200 || profileResult.status >= 300) {
        console.warn(`[agent_profile] Cloud returned HTTP ${profileResult.status} for agent ${agentId} — thin fallback`);
        const basic = await _storage.getAgentProfileFromGlobal(resolvedName || String(agentId));
        if (basic) {
          res.json(success(basic, 'agent_profile', (req as any).requestId));
          return;
        }
        res.status(profileResult.status).json(error('UPSTREAM_ERROR', `Cloud returned HTTP ${profileResult.status}`, 'agent_profile', (req as any).requestId));
        return;
      }

      const cloudProfile: CloudProfileShape | undefined = profileResult.body?.data?.profile;
      const responseAgentName: string | undefined = profileResult.body?.data?.agent_name;
      if (!cloudProfile) {
        console.warn(`[agent_profile] Cloud response missing data.profile for agent ${agentId} — thin fallback`);
        const basic = await _storage.getAgentProfileFromGlobal(resolvedName || String(agentId));
        if (basic) {
          res.json(success(basic, 'agent_profile', (req as any).requestId));
          return;
        }
        res.status(502).json(error('UPSTREAM_BAD_SHAPE', 'Cloud response missing profile data', 'agent_profile', (req as any).requestId));
        return;
      }

      const profile = mapCloudProfile(cloudProfile, {
        name: resolvedName || responseAgentName || String(agentId),
        displayName: displayName,
      });

      res.json(success(profile, 'agent_profile', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_profile', (req as any).requestId));
    }
  });

  // ── Skills persistence (NextPert #5 skill chips) ─────────────────────────

  // Load acp-skills.json catalog once at module init for validation
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  function loadSkillsCatalog(): string[] {
    try {
      const catalogPath = path.resolve(__dirname, '../../../acp-desktop/skills/acp-skills.json');
      const raw = fs.readFileSync(catalogPath, 'utf-8');
      const json = JSON.parse(raw);
      return (json.skills || []).map((s: any) => s.name);
    } catch (err) {
      console.warn('[agents/skills] Could not load acp-skills.json:', err);
      return [];
    }
  }
  const skillsCatalog = loadSkillsCatalog();

  // GET /v1/agents/:id/skills
  router.get('/:id/skills', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', 'agent_skills_get', (req as any).requestId));
        return;
      }
      const result = await queryVibeSql(
        `SELECT data FROM vibe.documents WHERE client_id = 0 AND collection = 'vibe_agents' AND table_name = 'agent_profiles' AND data->>'id' = ${escapeSql(String(id))} AND deleted_at IS NULL`
      );
      if (!result.success || !result.data?.length) {
        res.status(404).json(error('AGENT_NOT_FOUND', 'Agent not found', 'agent_skills_get', (req as any).requestId));
        return;
      }
      const data = typeof result.data[0].data === 'string' ? JSON.parse(result.data[0].data) : result.data[0].data;
      res.json(success({ skills: data.skills || [] }, 'agent_skills_get', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_skills_get', (req as any).requestId));
    }
  });

  // PUT /v1/agents/:id/skills
  router.put('/:id/skills', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'id must be an integer', 'agent_skills_put', (req as any).requestId));
        return;
      }
      const { skills } = req.body || {};
      if (!Array.isArray(skills) || skills.some((s: any) => typeof s !== 'string')) {
        res.status(400).json(error('VALIDATION_ERROR', 'skills must be an array of strings', 'agent_skills_put', (req as any).requestId));
        return;
      }
      const invalid = skills.filter((s: string) => !skillsCatalog.includes(s));
      if (invalid.length > 0 && skillsCatalog.length > 0) {
        res.status(400).json(error('VALIDATION_ERROR', `Invalid skills: ${invalid.join(', ')}. Valid: ${skillsCatalog.join(', ')}`, 'agent_skills_put', (req as any).requestId));
        return;
      }
      const patch = escapeJsonb({ skills });
      const sql = `UPDATE vibe.documents SET data = data || ${patch}, updated_at = NOW() WHERE client_id = 0 AND collection = 'vibe_agents' AND table_name = 'agent_profiles' AND data->>'id' = ${escapeSql(String(id))} AND deleted_at IS NULL RETURNING document_id, data`;
      const result = await queryVibeSql(sql);
      if (!result.success || !result.data?.length) {
        res.status(404).json(error('AGENT_NOT_FOUND', 'Agent not found', 'agent_skills_put', (req as any).requestId));
        return;
      }
      const rowData = result.data[0];
      const data = typeof rowData.data === 'string' ? JSON.parse(rowData.data) : rowData.data;
      res.json(success({ skills: data.skills || [] }, 'agent_skills_put', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'agent_skills_put', (req as any).requestId));
    }
  });

  return router;
}
