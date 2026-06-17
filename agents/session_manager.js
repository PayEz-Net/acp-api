// Phase 1: Stub session manager - no persistence
// All agent data goes through Vibe API

import { config } from '../config.js';
import { ensureValidToken, forceRefresh, requireTokenClientId } from '../api/auth/tokenManager.js';
import { extractAndMapCurrent, extractAndMapList } from '../api/projects/mapper.js';

const ROSTER_FETCH_TIMEOUT_MS = 10_000;
const ROSTER_TTL_MS = 5 * 60 * 1000; // refresh occasionally so newly-hired agents resolve
const PROJECT_TTL_MS = 60 * 1000;    // current-project / list soft cache (mirrors api/projects/cache.ts TTL)

export class SessionManager {
  constructor(_cfg) {
    this._sessions = new Map();
    // Agent roster is hydrated from VibeSQL at init() time.
    // Zero hardcoded names — canonical agent_profiles + team_agent_instances
    // are the one and only source of truth.
    this._agents = new Set();
    this._rosterHydratedAt = 0;   // 0 = never hydrated; lazy hydration on first authed read
    this._rosterHydrating = null; // in-flight hydration promise (coalesce concurrent reads)

    // Projects resolve from the CLOUD off the logged-in developer's bearer (BAPert 7291
    // one-resolver fix). The old in-memory stub (_activeProjectId=1 'vsql-server-dev') made
    // EVERY consumer scope to the wrong board off-LAN — Praveen's real project (Umibrowser 19)
    // was never loaded (Aurum 7287: stub-green is forbidden). getActiveProjectId/listProjects/
    // getProject now hit the existing cloud lane (GET /v1/users/me/current-project + /v1/projects),
    // soft-cached here (PROJECT_TTL_MS) mirroring api/projects/cache.ts. NO stub seed, NO _=1.
    this._currentProjectId = undefined; // undefined = not yet resolved; number|null after a resolve
    this._currentProjectAt = 0;
    this._projectListCache = null;
    this._projectListAt = 0;
    this._projects = new Map();          // retained only for createProject's in-memory path (TODO: cloud)
    this._nextProjectId = 1;

    // Phase 1 stub: agent documents registry is in-memory only. Real store
    // lives in vibe.documents alongside projects (client_id=9,
    // collection='vibe_agents'). Same TODO as projects: replace with a real
    // DocumentStore that queries VibeSQL Server once per-request client
    // context is plumbed through to SessionManager.
    this._documents = new Map();
    this._nextDocumentId = 1;

    // Documents loaded per-project from VibeSQL (vibe.documents).
    // No hardcoded seeds — every project sees only its own docs.

    // Kanban tasks now VibeSQL-backed (vibe.kanban_tasks)
    // Phase 1 in-memory _tasks Map removed 2026-05-06

    // Phase 1 stub: autonomy state is in-memory only. Supervisor writes
    // enabled/stopCondition/unattendedMode/etc. here via updateAutonomyState,
    // reads via getAutonomyState. Survives a single ACP session; doesn't
    // persist across restarts (which is actually fine — a restart should
    // clear unattended mode).
    this._autonomyState = null;
    this._standupEntries = [];
    this._nextStandupEntryId = 1;
  }

  async init() {
    // Hydrate the roster opportunistically. Pre-login this is NO_SESSION (returns false,
    // no throw) — lazy hydration on the first authed request (see _ensureRosterHydrated)
    // handles the real population. A genuine cloud error here is non-fatal at boot; the
    // lazy path will surface it on the request that needs the roster.
    try {
      await this._refreshAgentsRoster();
    } catch (err) {
      console.warn('[SessionManager] init roster hydrate deferred to first authed request:', err?.message || err);
    }
    return true;
  }

  // Cloud fetch over the Decision-C Bearer lane — the SAME reachable pattern as
  // api/routes/agents.ts cloudFetch (Bearer + X-Client-Id, no Vibe HMAC). Praveen (off-LAN)
  // reaches config.vibeApiUrl (api.idealvibe.online); he CANNOT reach a LAN dev box
  // the old raw-SQL paths targeted. GET by default; pass method+body for the current-project
  // writeback. Returns {status, body} or {error:'NO_SESSION'} pre-login.
  async _cloudGet(signedPath, opts = {}) {
    const token = await ensureValidToken(config.idpUrl, opts.trigger || 'cloud-get');
    if (!token) return { error: 'NO_SESSION' };

    const method = opts.method || 'GET';
    const hasBody = opts.body !== undefined && method !== 'GET' && method !== 'HEAD';
    const url = `${config.vibeApiUrl}${signedPath}`;
    const doFetch = async (bearer) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ROSTER_FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method,
          headers: {
            'Authorization': `Bearer ${bearer}`,
            'X-Client-Id': requireTokenClientId(bearer),
            'X-Vibe-Via': 'idp-proxy',
            'Content-Type': 'application/json',
          },
          body: hasBody ? JSON.stringify(opts.body) : undefined,
          signal: controller.signal,
        });
        const text = await res.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { /* leave null */ }
        return { status: res.status, body };
      } finally {
        clearTimeout(timer);
      }
    };

    let attempt = await doFetch(token);
    if (attempt.status === 401) {
      const refreshed = await forceRefresh(config.idpUrl, (opts.trigger || 'cloud-get') + '-401');
      if (!refreshed) return { error: 'NO_SESSION' };
      attempt = await doFetch(refreshed);
    }
    return attempt;
  }

  // Resolve the addressable agent roster from the CLOUD typed API (NOT raw SQL to the dev
  // box — that was the off-LAN "Agent X is not registered" blocker, BAPert/QA Praveen RCA).
  // Returns true on success (roster populated + hydrated-at stamped), false on NO_SESSION
  // (pre-login — not-yet, retry on next authed request). THROWS on a genuine cloud failure
  // so the caller SURFACES it — never the old silent fail-open to an empty _agents, which
  // read back as a silent "not registered" for every agent (no-unjustified-fallback).
  async _refreshAgentsRoster() {
    const result = await this._cloudGet('/v1/agentmail/agents', { trigger: 'roster-hydrate' });
    if ('error' in result) {
      if (result.error === 'NO_SESSION') return false; // pre-login: not-yet, not an error
      throw new Error(`agent roster cloud-resolve failed: ${result.error}`);
    }
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`agent roster cloud-resolve HTTP ${result.status} from ${config.vibeApiUrl}/v1/agentmail/agents`);
    }
    const agents = result.body?.data?.agents;
    if (!Array.isArray(agents)) {
      throw new Error('agent roster cloud-resolve: unexpected response shape (data.agents is not an array)');
    }
    const next = new Set();
    for (const a of agents) {
      if (a && typeof a.name === 'string') next.add(a.name);
    }
    this._agents = next;
    this._rosterHydratedAt = Date.now();
    return true;
  }

  // Lazy hydration — call before any roster read. ensureValidToken is NO_SESSION before the
  // user logs in, so we DON'T rely on init() alone. Coalesces concurrent hydrations; a genuine
  // cloud error PROPAGATES (surface + halt), NO_SESSION leaves the roster empty for a clean
  // retry on the next authed request.
  async _ensureRosterHydrated() {
    if (this._rosterHydratedAt && Date.now() - this._rosterHydratedAt < ROSTER_TTL_MS) return;
    if (!this._rosterHydrating) {
      this._rosterHydrating = this._refreshAgentsRoster().finally(() => { this._rosterHydrating = null; });
    }
    await this._rosterHydrating;
  }

  async load(agentName) {
    const session = this._sessions.get(agentName);
    return session ? { session, source: 'memory' } : null;
  }

  async save(session) {
    if (!session.agentName) return false;
    this._sessions.set(session.agentName, session);
    return { savedTo: ['memory'] };
  }

  async delete(agentName) {
    this._sessions.delete(agentName);
    return true;
  }

  async list() {
    return Array.from(this._sessions.values());
  }

  // For localAuth middleware compatibility (case-insensitive lookup)
  async getAgentRegistration(agentId) {
    const name = agentId.replace('agent:', '');
    // Lazy-hydrate the roster from the cloud (first authed request populates it; init() is
    // NO_SESSION pre-login). _ensureRosterHydrated THROWS on a genuine cloud failure.
    await this._ensureRosterHydrated();
    // Aurum 7269 NON-NEGOTIABLE: if the roster NEVER resolved (NO_SESSION / unreachable), do
    // NOT read back an empty roster as a silent "not registered" — that's the exact lie that
    // bit Praveen. Throw an HONEST error; the caller (localAuth/registry) surfaces it. A
    // not-found against a SUCCESSFULLY hydrated roster is the only legitimate not-registered.
    if (this._rosterHydratedAt === 0) {
      throw new Error('agent roster could not be resolved — no active session or the cloud roster is unreachable (not a registration state)');
    }
    // Case-insensitive match against known agents
    const match = Array.from(this._agents).find(a => a.toLowerCase() === name.toLowerCase());
    if (match) {
      return { name: match, registered: true };
    }
    return null;
  }

  // Stub methods for agent storage (routes expect these)
  async getAgentProfileFromGlobal(name) {
    await this._ensureRosterHydrated();
    // Case-insensitive match
    const match = Array.from(this._agents).find(a => a.toLowerCase() === name.toLowerCase());
    if (match) {
      return {
        name: match,
        displayName: match,
        role: 'agent',
        isActive: true,
      };
    }
    return null;
  }

  async getAgentById(id) {
    // Stub - not implemented in Phase 1
    return null;
  }

  async updateAgent(id, updates) {
    // Stub - not implemented in Phase 1
    return { id, ...updates };
  }

  async listActiveAgents() {
    await this._ensureRosterHydrated();
    // Return all known agents as active
    return Array.from(this._agents).map(name => ({
      name,
      displayName: name,
      isActive: true,
    }));
  }

  async listAllAgents() {
    return this.listActiveAgents();
  }

  async softDeleteAgent(id) {
    // Stub - not implemented in Phase 1
    return true;
  }

  async upsertAgent(agentData) {
    // Stub - not implemented in Phase 1
    return { id: 1, ...agentData };
  }

  async bulkUpdateStartupOrder(order) {
    // Stub - not implemented in Phase 1
    return true;
  }

  async listPoolProfiles() {
    // Stub - not implemented in Phase 1
    return [];
  }

  async getAgentByName(name) {
    const match = Array.from(this._agents).find(a => a.toLowerCase() === name.toLowerCase());
    if (match) {
      return { name: match, id: 1 };
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // Project registry — Phase 1 in-memory stub.
  // Backs api/routes/projects.ts so the Electron UI dropdown can load and
  // the active project can be selected. Persisted row for id=1 exists in
  // vibe.documents (client 9, agent_mail/vibe_projects) for the cloud mail
  // handler to satisfy ProjectExistsAsync; this in-memory copy mirrors it
  // so the local API doesn't need to hit VibeSQL on every list call.
  // -----------------------------------------------------------------------

  // Cloud project list for the logged-in developer (GET /v1/projects?activeOnly=true),
  // soft-cached. Maps to the {id, name, description, status} shape consumers read.
  async listProjects() {
    if (this._projectListCache && Date.now() - this._projectListAt < PROJECT_TTL_MS) {
      return this._projectListCache;
    }
    const result = await this._cloudGet('/v1/projects?activeOnly=true', { trigger: 'project-list' });
    if ('error' in result) return this._projectListCache ?? []; // NO_SESSION pre-login: last-known or empty
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`project list cloud-resolve HTTP ${result.status} from ${config.vibeApiUrl}/v1/projects`);
    }
    const mapped = extractAndMapList(result.body) || [];
    this._projectListCache = mapped.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description ?? '',
      status: p.is_active === false ? 'inactive' : 'active',
    }));
    this._projectListAt = Date.now();
    return this._projectListCache;
  }

  async getProject(id) {
    const key = Number(id);
    const list = await this.listProjects();
    return list.find((p) => Number(p.id) === key) || null;
  }

  // The logged-in developer's CURRENT (startup) project, resolved off their bearer via the
  // existing cloud focus-pointer (GET /v1/users/me/current-project) — NOT the killed _=1 stub.
  // null = unset/empty (no project selected); consumers treat null as "no active project"
  // (picker / create-CTA), never a silent default (no-unjustified-fallback / Aurum 7287).
  async getActiveProjectId() {
    if (this._currentProjectId !== undefined && Date.now() - this._currentProjectAt < PROJECT_TTL_MS) {
      return this._currentProjectId;
    }
    const result = await this._cloudGet('/v1/users/me/current-project', { trigger: 'current-project' });
    if ('error' in result) return this._currentProjectId ?? null; // NO_SESSION pre-login
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`current-project cloud-resolve HTTP ${result.status} from ${config.vibeApiUrl}/v1/users/me/current-project`);
    }
    const mapped = extractAndMapCurrent(result.body);
    this._currentProjectId = mapped.current_project_id ?? null;
    this._currentProjectAt = Date.now();
    return this._currentProjectId;
  }

  // Focus writeback to the cloud (PUT /v1/users/me/current-project { project_id }) so the
  // developer's startup project persists tenant-wide; updates the local soft cache.
  async setActiveProjectId(id) {
    const key = id === null ? null : Number(id);
    const result = await this._cloudGet('/v1/users/me/current-project', {
      method: 'PUT',
      body: { project_id: key },
      trigger: 'current-project-set',
    });
    if ('error' in result) return false; // NO_SESSION
    if (result.status < 200 || result.status >= 300) return false;
    this._currentProjectId = key;
    this._currentProjectAt = Date.now();
    return true;
  }

  async createProject(data) {
    if (!data || !data.name) {
      throw new Error('createProject: name is required');
    }
    const id = this._nextProjectId++;
    const project = {
      id,
      name: data.name,
      description: data.description || '',
      status: data.status || 'active',
      created_at: new Date().toISOString(),
    };
    this._projects.set(id, project);
    return project;
  }

  // -----------------------------------------------------------------------
  // Agent documents — Phase 1 in-memory stub.
  // Backs api/routes/documents.ts so the Electron DocumentSidebar stops
  // 500-ing on load. Returns an empty list until real VibeSQL wiring lands.
  // -----------------------------------------------------------------------

  async createDocument(fields) {
    const id = this._nextDocumentId++;
    const doc = {
      id,
      project_id: fields.project_id ?? null,
      title: fields.title ?? '',
      content_md: fields.content_md ?? '',
      type: fields.type ?? 'reference',
      version: fields.version ?? '1.0',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this._documents.set(id, doc);
    return doc;
  }

  async listDocuments(filter = {}) {
    let docs = Array.from(this._documents.values());
    if (filter.project_id !== undefined) {
      docs = docs.filter(d => d.project_id === filter.project_id);
    }
    return docs;
  }

  async getDocument(id) {
    const key = Number(id);
    return this._documents.get(key) || null;
  }

  async updateDocument(id, updates) {
    const key = Number(id);
    const existing = this._documents.get(key);
    if (!existing) return null;
    const next = {
      ...existing,
      ...(updates.project_id !== undefined ? { project_id: updates.project_id } : {}),
      ...(updates.title !== undefined ? { title: updates.title } : {}),
      ...(updates.content_md !== undefined ? { content_md: updates.content_md } : {}),
      ...(updates.document_type !== undefined ? { type: updates.document_type } : {}),
      ...(updates.version !== undefined ? { version: updates.version } : {}),
      updated_at: new Date().toISOString(),
    };
    this._documents.set(key, next);
    return next;
  }

  async deleteDocument(id) {
    const key = Number(id);
    return this._documents.delete(key);
  }

  // -----------------------------------------------------------------------
  // Autonomy state — Phase 1 in-memory stub.
  // Backs autonomy/supervisor.js for unattended-mode start/stop/status.
  // State is a flat object merged by updateAutonomyState; null when
  // autonomy has never run this session. Doesn't persist across restarts,
  // which matches the desired behavior (restart = clean slate for unattended).
  // -----------------------------------------------------------------------

  async getAutonomyState() {
    return this._autonomyState;
  }

  async updateAutonomyState(partial) {
    this._autonomyState = {
      ...(this._autonomyState ?? {}),
      ...partial,
    };
    return this._autonomyState;
  }

  // Standup entries — in-memory ring for supervisor status writes.
  async createStandupEntry(entry) {
    const id = this._nextStandupEntryId++;
    const row = {
      id,
      created_at: new Date().toISOString(),
      ...entry,
    };
    this._standupEntries.push(row);
    // Keep the ring bounded so a long unattended run doesn't eat memory.
    if (this._standupEntries.length > 500) {
      this._standupEntries.splice(0, this._standupEntries.length - 500);
    }
    return id;
  }

  async listStandupEntries(filter = {}) {
    let rows = this._standupEntries.slice();
    if (filter.agent) {
      rows = rows.filter(r => r.agent === filter.agent);
    }
    if (filter.type) {
      rows = rows.filter(r => r.type === filter.type);
    }
    if (filter.limit) {
      rows = rows.slice(-filter.limit);
    }
    return rows;
  }

  // -----------------------------------------------------------------------
  // Kanban tasks — VibeSQL-backed store
  // Schema: vibe.kanban_tasks
  // -----------------------------------------------------------------------

  // Decision-C / no-unjustified-fallback: NO dev-box default. The roster no longer uses raw
  // VibeSQL at all (it cloud-resolves). The remaining raw consumers (kanban) read these from
  // env only; absent -> _queryVibeSql hard-fails with a surfaced error rather than silently
  // targeting a LAN dev box in a public install (the off-LAN Praveen-class hazard).
  _vibeSqlUrl = process.env.VIBESQL_URL || null;
  _vibeSqlSecret = process.env.VIBESQL_SECRET || null;

  _escapeSql(value) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return 'NULL';
      return String(value);
    }
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    return "'" + String(value).replace(/'/g, "''") + "'";
  }

  async _queryVibeSql(sql) {
    if (!this._vibeSqlUrl || !this._vibeSqlSecret) {
      // Surface + halt — never silently fall back to the dev box (Decision-C). Raw /v1/query
      // is dev-only; a public install must not reach it. The registration/roster path does
      // NOT use this (it cloud-resolves); this guards the remaining raw consumers (kanban).
      throw new Error('VIBESQL_URL / VIBESQL_SECRET not configured — raw VibeSQL is dev-only and is not available in this build. Use the cloud typed API.');
    }
    const res = await fetch(`${this._vibeSqlUrl}/v1/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Secret ${this._vibeSqlSecret}`,
      },
      body: JSON.stringify({ sql }),
    });
    const data = await res.json().catch(() => ({ success: false }));
    return data;
  }

  _rowToTask(row) {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      assignedTo: row.assigned_to,
      createdBy: row.created_by,
      specPath: row.spec_path,
      milestone: row.milestone,
      filesChanged: Array.isArray(row.files_changed) ? row.files_changed : (typeof row.files_changed === 'string' ? JSON.parse(row.files_changed) : []),
      blockers: row.blockers,
      archived: row.archived === true,
      projectId: row.project_id ?? null,
      created_at: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }

  // ── Off-LAN kanban migration (BAPert 7274 / DnP 7279 typed contracts) ────────────────
  // General cloud typed-API call on the SAME Decision-C lane as the roster (Bearer +
  // X-Client-Id from the bearer, no Vibe HMAC). Reaches config.vibeApiUrl
  // (api.idealvibe.online) — NOT the dev box — so off-LAN (Praveen) works. THROWS on
  // no-session / non-2xx / transport so the caller SURFACES it (never a silent empty or
  // dev-box fallback — the exact lie we're removing).
  async _cloudKanban(method, path, body) {
    const token = await ensureValidToken(config.idpUrl, 'kanban');
    if (!token) throw new Error(`kanban ${method} ${path}: NO_SESSION (log in first)`);
    const url = `${config.vibeApiUrl}${path}`;
    const doFetch = async (bearer) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ROSTER_FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method,
          headers: {
            'Authorization': `Bearer ${bearer}`,
            'X-Client-Id': requireTokenClientId(bearer),
            'X-Vibe-Via': 'idp-proxy',
            'Content-Type': 'application/json',
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        const text = await res.text();
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* leave null */ }
        return { status: res.status, body: parsed };
      } finally {
        clearTimeout(timer);
      }
    };
    let attempt = await doFetch(token);
    if (attempt.status === 401) {
      const refreshed = await forceRefresh(config.idpUrl, 'kanban-401');
      if (!refreshed) throw new Error(`kanban ${method} ${path}: NO_SESSION after refresh`);
      attempt = await doFetch(refreshed);
    }
    if (attempt.status < 200 || attempt.status >= 300) {
      const msg = attempt.body?.error?.message || attempt.body?.error || `HTTP ${attempt.status}`;
      throw new Error(`kanban ${method} ${path}: ${msg}`);
    }
    return attempt.body;
  }

  // Cloud kanban endpoints are project-scoped (/v1/projects/{id}/kanban/*, DnP 7279).
  // A missing project id is a hard error, never a silent global query.
  _requireProjectId(projectId, op) {
    if (projectId == null) {
      throw new Error(`kanban ${op}: projectId is required (cloud kanban endpoints are project-scoped)`);
    }
    return Number(projectId);
  }

  async createTask(task, projectId) {
    const pid = this._requireProjectId(projectId, 'createTask');
    const body = {
      title: task.title,
      description: task.description,
      status: task.status || 'backlog',
      priority: task.priority || 'medium',
      assigned_to: task.assignedTo,
      created_by: task.createdBy,
      spec_path: task.specPath,
      milestone: task.milestone,
      files_changed: task.filesChanged || [],
      blockers: task.blockers,
    };
    const res = await this._cloudKanban('POST', `/v1/projects/${pid}/kanban/tasks`, body);
    const id = res?.data?.id;
    if (id == null) throw new Error('createTask: cloud response missing data.id');
    return id;
  }

  async getTask(id, projectId) {
    const pid = this._requireProjectId(projectId, 'getTask');
    const res = await this._cloudKanban('GET', `/v1/projects/${pid}/kanban/tasks/${Number(id)}`);
    const t = res?.data;
    if (!t) return null;
    return this._rowToTask(t);
  }

  // Maps to the EXISTING cloud board reads (GET /v1/projects/{id}/kanban/active|done|waiting,
  // DnP 7279). Those return board columns, so to reproduce the old arbitrary-filter SELECT we
  // fetch ALL three boards, merge (dedupe by id), then apply the remaining predicates IN-MEMORY
  // — exactly what the SQL did — instead of guessing a status->board mapping. A failed fetch
  // THROWS (surfaced), never a silent []. FLAGGED to DnP: confirms board read wrapper shape
  // (assumed { data: { tasks: [...] } } | { data: [...] }).
  async listTasks(filter = {}) {
    const pid = this._requireProjectId(filter.projectId, 'listTasks');
    const seen = new Map();
    for (const board of ['active', 'done', 'waiting']) {
      const res = await this._cloudKanban('GET', `/v1/projects/${pid}/kanban/${board}`);
      const tasks = res?.data?.tasks ?? res?.data ?? [];
      for (const t of (Array.isArray(tasks) ? tasks : [])) {
        const mapped = this._rowToTask(t);
        if (mapped.id != null) seen.set(mapped.id, mapped);
      }
    }
    let rows = Array.from(seen.values());
    // In-memory predicates mirroring the prior SQL. archived three-valued: legacy null = NOT archived.
    if (filter.archived === true) rows = rows.filter(r => r.archived === true);
    else if (!filter.includeArchived) rows = rows.filter(r => r.archived !== true);
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      rows = rows.filter(r => statuses.includes(r.status));
    }
    if (filter.assignedTo) rows = rows.filter(r => r.assignedTo === filter.assignedTo);
    if (filter.milestone) rows = rows.filter(r => r.milestone === filter.milestone);
    if (filter.priority) rows = rows.filter(r => r.priority === filter.priority);
    rows.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
    return rows;
  }

  async updateTask(id, updates, projectId) {
    const pid = this._requireProjectId(projectId, 'updateTask');
    const body = {};
    if (updates.status !== undefined) body.status = updates.status;
    if (updates.priority !== undefined) body.priority = updates.priority;
    if (updates.assignedTo !== undefined) body.assigned_to = updates.assignedTo;
    if (updates.milestone !== undefined) body.milestone = updates.milestone;
    if (updates.specPath !== undefined) body.spec_path = updates.specPath;
    if (updates.blockers !== undefined) body.blockers = updates.blockers;
    if (updates.description !== undefined) body.description = updates.description;
    if (updates.title !== undefined) body.title = updates.title;
    if (updates.filesChanged !== undefined) body.files_changed = updates.filesChanged;
    if (updates.archived !== undefined) body.archived = updates.archived;
    // status transitions auto-stamp started_at/completed_at server-side (DnP 7279) — don't send timestamps.
    if (Object.keys(body).length === 0) return this.getTask(id, projectId);
    const res = await this._cloudKanban('PATCH', `/v1/projects/${pid}/kanban/tasks/${Number(id)}`, body);
    const t = res?.data;
    if (!t) return null;
    return this._rowToTask(t);
  }

  // ── #64 G4: kanban activity / audit trail (vibe.kanban_activity) ──────────
  async appendKanbanActivity({ taskId, actor, action, fromStatus, toStatus, detail, projectId }) {
    const pid = this._requireProjectId(projectId, 'appendKanbanActivity');
    const res = await this._cloudKanban('POST', `/v1/projects/${pid}/kanban/tasks/${Number(taskId)}/activity`, {
      actor, action, from_status: fromStatus, to_status: toStatus, detail,
    });
    return res?.data?.id ?? null;
  }

  async listKanbanActivity(taskId, projectId) {
    const pid = this._requireProjectId(projectId, 'listKanbanActivity');
    const res = await this._cloudKanban('GET', `/v1/projects/${pid}/kanban/tasks/${Number(taskId)}/activity`);
    const activity = res?.data?.activity ?? [];
    return (Array.isArray(activity) ? activity : []).map(r => ({
      activity_id: r.id, task_id: Number(taskId), actor: r.actor, action: r.action,
      from: r.from_status, to: r.to_status, detail: r.detail, at: r.created_at,
    }));
  }

  // ── #64 G3: kanban comments thread (vibe.kanban_comments) ────────────────
  async addKanbanComment({ taskId, author, bodyMd, projectId }) {
    const pid = this._requireProjectId(projectId, 'addKanbanComment');
    const res = await this._cloudKanban('POST', `/v1/projects/${pid}/kanban/tasks/${Number(taskId)}/comments`, {
      author, body_md: bodyMd,
    });
    const id = res?.data?.id ?? null;
    return { comment_id: id, task_id: Number(taskId), author, body_md: bodyMd, created_at: new Date().toISOString() };
  }

  async listKanbanComments(taskId, projectId) {
    const pid = this._requireProjectId(projectId, 'listKanbanComments');
    const res = await this._cloudKanban('GET', `/v1/projects/${pid}/kanban/tasks/${Number(taskId)}/comments`);
    const comments = res?.data?.comments ?? [];
    return (Array.isArray(comments) ? comments : []).map(r => ({
      comment_id: r.id, task_id: Number(taskId), author: r.author, body_md: r.body_md, created_at: r.created_at,
    }));
  }

  get storage() {
    // Return stub storage for compatibility
    const self = this;
    return {
      getSession: (name) => this.load(name),
      saveSession: (s) => this.save(s),
      deleteSession: (name) => this.delete(name),
      listSessions: () => this.list(),
      getAgentRegistration: (id) => this.getAgentRegistration(id),
      init: () => Promise.resolve(),
      // Agent storage methods
      getAgentProfileFromGlobal: (name) => self.getAgentProfileFromGlobal(name),
      getAgentById: (id) => self.getAgentById(id),
      updateAgent: (id, updates) => self.updateAgent(id, updates),
      listActiveAgents: () => self.listActiveAgents(),
      listAllAgents: () => self.listAllAgents(),
      softDeleteAgent: (id) => self.softDeleteAgent(id),
      upsertAgent: (data) => self.upsertAgent(data),
      bulkUpdateStartupOrder: (order) => self.bulkUpdateStartupOrder(order),
      listPoolProfiles: () => self.listPoolProfiles(),
      getAgentByName: (name) => self.getAgentByName(name),
      // Project registry — forwards to the in-memory Phase 1 stub above.
      listProjects: () => self.listProjects(),
      getProject: (id) => self.getProject(id),
      getActiveProjectId: () => self.getActiveProjectId(),
      setActiveProjectId: (id) => self.setActiveProjectId(id),
      createProject: (data) => self.createProject(data),
      // Agent documents — forwards to the in-memory Phase 1 stub above.
      createDocument: (fields) => self.createDocument(fields),
      listDocuments: (filter) => self.listDocuments(filter),
      getDocument: (id) => self.getDocument(id),
      updateDocument: (id, updates) => self.updateDocument(id, updates),
      deleteDocument: (id) => self.deleteDocument(id),
      // Kanban tasks — forwards to the in-memory Phase 1 stub above.
      createTask: (data, projectId) => self.createTask(data, projectId),
      getTask: (id, projectId) => self.getTask(id, projectId),
      listTasks: (filter) => self.listTasks(filter),
      updateTask: (id, updates, projectId) => self.updateTask(id, updates, projectId),
      // #64 kanban mutation surface — activity (G4) + comments (G3)
      appendKanbanActivity: (e) => self.appendKanbanActivity(e),
      listKanbanActivity: (id, projectId) => self.listKanbanActivity(id, projectId),
      addKanbanComment: (c) => self.addKanbanComment(c),
      listKanbanComments: (id, projectId) => self.listKanbanComments(id, projectId),
      // Autonomy state + standup entries — forwards to the stubs above.
      getAutonomyState: () => self.getAutonomyState(),
      updateAutonomyState: (partial) => self.updateAutonomyState(partial),
      createStandupEntry: (entry) => self.createStandupEntry(entry),
      listStandupEntries: (filter) => self.listStandupEntries(filter),
    };
  }
}
