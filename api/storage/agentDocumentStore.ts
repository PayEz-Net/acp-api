import { config } from '../../config.js';
import { ensureValidToken, getAccessToken, getSession, requireTokenClientId } from '../auth/tokenManager.js';

const VIBE_API_URL = config.vibeApiUrl || null;

/**
 * VibeSQL-backed store for agent documents.
 *
 * Stores documents in the shared vibe.documents JSONB table under the
 * vibe_agents/agent_documents collection/table, matching the schema used by
 * PayEz-Core's AgentDocumentRepository.
 *
 * All storage goes through the bearer-authenticated Vibe API. There is no
 * in-memory fallback and no secret-based path.
 *
 * 2026-07-28 (ACP-ISSUES #1): rewired from the raw-SQL passthrough
 * (POST /v1/query — died in the merge, 404 empty body) to the live
 * table-documents REST contract (/v1/collections/:c/tables/:t[/:id]),
 * the same surface idealvibe's lib/vibe-admin.ts uses. Filtering that the
 * SQL used to do (project/agent/is_deleted/parent-suppression) is now
 * client-side — document volumes are small. Responses are normalized
 * defensively (items ?? rows ?? documents ?? array), same lesson as the
 * kanban data.items fix.
 */

interface AgentDocument {
  id: number;
  project_id: number | null;
  title: string;
  content_md: string;
  type: string;
  version: number;
  author_agent?: string;
  parent_document_id?: number | null;
  created_at: string;
  updated_at?: string;
}

interface CreateFields {
  project_id?: number | null;
  title: string;
  content_md: string;
  type?: string;
  version?: string | number;
  agentName?: string;
  clientId?: number;
  userId?: number;
}

interface UpdateFields {
  title?: string;
  content_md?: string;
  document_type?: string;
  version?: string | number;
  agentName?: string;
  clientId?: number;
  userId?: number;
}

interface ListFilter {
  project_id?: number;
  agentName?: string;
  clientId?: number;
  userId?: number;
}

const COLLECTION = 'vibe_agents';
const TABLE_NAME = 'agent_documents';
const DEFAULT_CLIENT_ID = 0;
const DEFAULT_USER_ID = 0;

interface AuthContext {
  token: string;
  clientId: number;
  userId: number;
}

export class AgentDocumentStore {
  private vibeApiUrl: string | null;

  constructor() {
    this.vibeApiUrl = VIBE_API_URL;
  }

  private async getAuthContext(): Promise<AuthContext> {
    if (!this.vibeApiUrl) {
      throw new Error('VIBE_API_URL not configured');
    }
    let token = getAccessToken();
    if (!token) {
      token = await ensureValidToken(config.idpUrl);
    }
    if (!token) {
      throw new Error('No active IDP session — cannot query VibeSQL documents');
    }

    let clientId: number;
    try {
      clientId = parseInt(requireTokenClientId(token), 10);
      if (!Number.isFinite(clientId)) throw new Error('invalid client_id');
    } catch {
      throw new Error('Bearer token missing valid client_id claim');
    }

    // ACP-ISSUES #8: doc ids "renumbered" across restarts. Root cause: rows are
    // tenant-scoped by the TOKEN'S client_id claim, which drifts across sessions
    // for multi-client users (8/9/76…) — old docs go tenant-invisible and a
    // republish mints new ids. Pin the docs tenant with ACP_DOCS_CLIENT_ID when
    // set; token claim stays the fallback for backwards compatibility.
    const pinnedClient = parseInt(process.env.ACP_DOCS_CLIENT_ID || '', 10);
    if (Number.isFinite(pinnedClient)) clientId = pinnedClient;

    const session = getSession();
    let userId = DEFAULT_USER_ID;
    if (session) {
      const parsed = parseInt(session.userId, 10);
      if (!Number.isNaN(parsed)) userId = parsed;
    }

    return { token, clientId, userId };
  }

  private async resolveContext(ctx?: { clientId?: number; userId?: number }): Promise<{ clientId: number; userId: number; auth: AuthContext }> {
    const auth = await this.getAuthContext();
    let clientId = ctx?.clientId ?? DEFAULT_CLIENT_ID;
    let userId = ctx?.userId ?? DEFAULT_USER_ID;
    if (clientId === DEFAULT_CLIENT_ID) clientId = auth.clientId;
    if (userId === DEFAULT_USER_ID) userId = auth.userId;
    return { clientId, userId, auth };
  }

  // ---- REST layer (replaces the raw-SQL query()) --------------------------

  private async rest(method: string, path: string, body?: any): Promise<any> {
    const auth = await this.getAuthContext();
    const res = await fetch(`${this.vibeApiUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${auth.token}`,
        'X-Client-Id': String(auth.clientId),
        'X-Vibe-Via': 'idp-proxy',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (!res.ok || (json && json.success === false)) {
      const msg = (json && (json.error?.message || json.message)) || text.slice(0, 200) || '(empty body)';
      throw new Error(`Vibe REST ${method} ${path} -> ${res.status}: ${msg}`);
    }
    return json ?? {};
  }

  private tablePath(suffix = ''): string {
    return `/v1/collections/${COLLECTION}/tables/${TABLE_NAME}${suffix}`;
  }

  /** Defensive row extraction — upstream list shapes vary (items/rows/documents/bare array). */
  private extractRows(payload: any): any[] {
    const d = payload?.data ?? payload;
    const rows = d?.items ?? d?.rows ?? d?.documents ?? (Array.isArray(d) ? d : null);
    return Array.isArray(rows) ? rows : [];
  }

  private rowData(row: any): any {
    if (!row) return {};
    const d = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    return d ?? {};
  }

  /** All live rows for this client (server scopes tenant via X-Client-Id; belt filter kept). */
  private async listAllRows(clientId: number): Promise<any[]> {
    const payload = await this.rest('GET', this.tablePath('?limit=1000'));
    return this.extractRows(payload)
      .filter((r) => r?.client_id == null || Number(r.client_id) === clientId);
  }

  private rowToDoc(row: any): AgentDocument {
    const data = this.rowData(row);
    return {
      id: data.document_id ?? row?.document_id ?? row?.id,
      project_id: data.project_id ?? null,
      title: data.title ?? '',
      content_md: data.content_md ?? '',
      type: data.doc_type ?? 'reference',
      version: typeof data.version === 'number' ? data.version : Number(data.version) || 1,
      author_agent: data.agent_name,
      parent_document_id: data.parent_document_id ?? null,
      created_at: data.created_at ?? row?.created_at,
      updated_at: data.updated_at ?? row?.updated_at,
    };
  }

  private nextLogicalId(rows: any[]): number {
    return rows.reduce((m, r) => Math.max(m, Number(this.rowData(r).document_id) || 0), 0) + 1;
  }

  private slugFile(title: string): string {
    const slug = String(title || 'document').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'document';
    return `${slug}.md`;
  }

  // ---- CRUD (same semantics as the SQL version) ---------------------------

  async createDocument(fields: CreateFields): Promise<AgentDocument> {
    const { clientId, userId } = await this.resolveContext(fields);
    const version = typeof fields.version === 'number' ? fields.version : Number(fields.version) || 1;
    const now = new Date().toISOString();

    const rows = await this.listAllRows(clientId);
    const data = {
      document_id: this.nextLogicalId(rows),
      agent_name: fields.agentName || 'system',
      // Post-merge upstream contract: agent_documents requires agent_id/filename/mime_type/size_bytes.
      agent_id: 0,
      filename: this.slugFile(fields.title),
      mime_type: 'text/markdown',
      size_bytes: Buffer.byteLength(fields.content_md, 'utf8'),
      project_id: fields.project_id ?? null,
      title: fields.title,
      content_md: fields.content_md,
      blob_storage_key: null,
      doc_type: (fields.type || 'reference').toLowerCase(),
      version,
      parent_document_id: null,
      content_size_bytes: Buffer.byteLength(fields.content_md, 'utf8'),
      is_deleted: false,
      created_at: now,
      created_by: userId,
      updated_at: null,
      updated_by: null,
      deleted_at: null,
      deleted_by: null,
    };

    const payload = await this.rest('POST', this.tablePath(), data);
    const created = this.extractRows(payload)[0] ?? payload?.data ?? { data };
    return this.rowToDoc(created);
  }

  async listDocuments(filter: ListFilter = {}): Promise<AgentDocument[]> {
    const { clientId } = await this.resolveContext(filter);
    const rows = await this.listAllRows(clientId);

    let docs = rows
      .map((row) => ({ row, data: this.rowData(row) }))
      .filter((x) => x.data.is_deleted !== true)
      .filter((x) => filter.project_id === undefined || Number(x.data.project_id) === filter.project_id)
      .filter((x) => filter.agentName === undefined
        || String(x.data.agent_name || '').toLowerCase() === String(filter.agentName).toLowerCase());

    // Parent suppression: only the newest version of a document chain is listed.
    const parentIds = new Set(
      docs.filter((x) => x.data.parent_document_id != null).map((x) => String(x.data.parent_document_id)),
    );
    docs = docs.filter((x) => !parentIds.has(String(x.data.document_id)));

    docs.sort((a, b) => String(b.data.created_at || '').localeCompare(String(a.data.created_at || '')));
    return docs.slice(0, 1000).map((x) => this.rowToDoc(x.row));
  }

  async getDocument(id: number, ctx?: { clientId?: number; agentName?: string }): Promise<AgentDocument | null> {
    const { clientId } = await this.resolveContext(ctx);
    const rows = await this.listAllRows(clientId);
    const hit = rows
      .map((row) => ({ row, data: this.rowData(row) }))
      .filter((x) => Number(x.data.document_id) === Number(id))
      .filter((x) => x.data.is_deleted !== true)
      .filter((x) => ctx?.agentName === undefined
        || String(x.data.agent_name || '').toLowerCase() === String(ctx.agentName).toLowerCase())
      .sort((a, b) => String(b.data.created_at || '').localeCompare(String(a.data.created_at || '')))[0];
    return hit ? this.rowToDoc(hit.row) : null;
  }

  async updateDocument(id: number, updates: UpdateFields): Promise<AgentDocument | null> {
    const { clientId, userId } = await this.resolveContext(updates);
    const existing = await this.getDocument(id, updates);
    if (!existing) return null;

    const rows = await this.listAllRows(clientId);
    const now = new Date().toISOString();
    const title = updates.title ?? existing.title;
    const content = updates.content_md ?? existing.content_md;

    // Versioning model preserved: an update INSERTs a new row chained via parent_document_id.
    const data = {
      document_id: this.nextLogicalId(rows),
      agent_name: existing.author_agent || updates.agentName || 'system',
      agent_id: 0,
      filename: this.slugFile(title),
      mime_type: 'text/markdown',
      size_bytes: Buffer.byteLength(content, 'utf8'),
      project_id: existing.project_id,
      title,
      content_md: content,
      blob_storage_key: null,
      doc_type: (updates.document_type ?? existing.type).toLowerCase(),
      version: (existing.version || 1) + 1,
      parent_document_id: Number(id),
      content_size_bytes: Buffer.byteLength(content, 'utf8'),
      is_deleted: false,
      created_at: now,
      created_by: userId,
      updated_at: null,
      updated_by: null,
      deleted_at: null,
      deleted_by: null,
    };

    const payload = await this.rest('POST', this.tablePath(), data);
    const created = this.extractRows(payload)[0] ?? payload?.data ?? { data };
    return this.rowToDoc(created);
  }

  async deleteDocument(id: number, ctx?: { clientId?: number; userId?: number; agentName?: string }): Promise<boolean> {
    const { clientId, userId } = await this.resolveContext(ctx);
    const rows = await this.listAllRows(clientId);
    const target = rows
      .map((row) => ({ row, data: this.rowData(row) }))
      .find((x) => Number(x.data.document_id) === Number(id)
        && x.data.is_deleted !== true
        && (ctx?.agentName === undefined
          || String(x.data.agent_name || '').toLowerCase() === String(ctx.agentName).toLowerCase()));
    if (!target) return false;

    const rowId = target.row.document_id ?? target.row.id;
    if (rowId == null) throw new Error('Vibe REST delete: row id missing on stored document');
    const now = new Date().toISOString();
    await this.rest('PUT', this.tablePath(`/${rowId}`), {
      ...target.data,
      is_deleted: true,
      deleted_at: now,
      deleted_by: userId,
    });
    return true;
  }
}
