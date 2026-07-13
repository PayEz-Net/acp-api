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

  private async query(sql: string): Promise<any> {
    const auth = await this.getAuthContext();
    const res = await fetch(`${this.vibeApiUrl}/v1/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${auth.token}`,
        'X-Client-Id': String(auth.clientId),
        'X-Vibe-Via': 'idp-proxy',
      },
      body: JSON.stringify({ sql }),
    });
    const data = await res.json().catch(() => ({ success: false, error: { message: 'Invalid JSON response' } }));
    if (!data.success) {
      const msg = data.error?.message || JSON.stringify(data.error);
      throw new Error(`VibeSQL error: ${msg}`);
    }
    return data;
  }

  private rowToDoc(row: any): AgentDocument {
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    return {
      id: data.document_id ?? row.document_id,
      project_id: data.project_id ?? null,
      title: data.title ?? '',
      content_md: data.content_md ?? '',
      type: data.doc_type ?? 'reference',
      version: typeof data.version === 'number' ? data.version : Number(data.version) || 1,
      author_agent: data.agent_name,
      parent_document_id: data.parent_document_id ?? null,
      created_at: data.created_at ?? row.created_at,
      updated_at: data.updated_at ?? row.updated_at,
    };
  }

  async createDocument(fields: CreateFields): Promise<AgentDocument> {
    const { clientId, userId } = await this.resolveContext(fields);

    const version = typeof fields.version === 'number' ? fields.version : Number(fields.version) || 1;
    const now = new Date().toISOString();

    const nextRes = await this.query(`
      SELECT COALESCE(MAX(CAST(d.data->>'document_id' AS INTEGER)), 0) + 1 AS next_id
      FROM vibe.documents d
      WHERE d.client_id = ${clientId}
        AND d.collection = ${this.escapeSql(COLLECTION)}
        AND d.table_name = ${this.escapeSql(TABLE_NAME)}
    `);
    const nextId = nextRes.data?.[0]?.next_id ?? 1;

    const dataJson = JSON.stringify({
      document_id: nextId,
      agent_name: fields.agentName || 'system',
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
    });

    const insertRes = await this.query(`
      INSERT INTO vibe.documents
        (client_id, owner_user_id, collection, table_name, data, created_at, created_by)
      VALUES
        (${clientId}, ${userId}, ${this.escapeSql(COLLECTION)}, ${this.escapeSql(TABLE_NAME)}, ${this.escapeSql(dataJson)}::jsonb, ${this.escapeSql(now)}, ${userId})
      RETURNING document_id, data, created_at
    `);

    const row = insertRes.data?.[0];
    if (!row) throw new Error('VibeSQL did not return created document');
    return this.rowToDoc(row);
  }

  async listDocuments(filter: ListFilter = {}): Promise<AgentDocument[]> {
    const { clientId } = await this.resolveContext(filter);

    const projectClause = filter.project_id === undefined
      ? ''
      : `AND (d.data->>'project_id')::INTEGER = ${filter.project_id}`;
    const agentClause = filter.agentName === undefined
      ? ''
      : `AND LOWER(d.data->>'agent_name') = LOWER(${this.escapeSql(filter.agentName)})`;

    const res = await this.query(`
      WITH docs AS (
        SELECT d.document_id AS vibe_doc_id, d.data, d.created_at
        FROM vibe.documents d
        WHERE d.client_id = ${clientId}
          AND d.collection = ${this.escapeSql(COLLECTION)}
          AND d.table_name = ${this.escapeSql(TABLE_NAME)}
          AND COALESCE((d.data->>'is_deleted')::BOOLEAN, FALSE) = FALSE
          ${projectClause}
          ${agentClause}
      ),
      parents AS (
        SELECT DISTINCT (d.data->>'parent_document_id')::INTEGER AS parent_id
        FROM docs d
        WHERE d.data->>'parent_document_id' IS NOT NULL
      )
      SELECT d.*
      FROM docs d
      WHERE d.data->>'document_id' NOT IN (SELECT p.parent_id::TEXT FROM parents p WHERE p.parent_id IS NOT NULL)
      ORDER BY d.created_at DESC
      LIMIT 1000
    `);

    const rows = res.data || [];
    return rows.map((r: any) => this.rowToDoc(r));
  }

  async getDocument(id: number, ctx?: { clientId?: number; agentName?: string }): Promise<AgentDocument | null> {
    const { clientId } = await this.resolveContext(ctx);

    const agentClause = ctx?.agentName === undefined
      ? ''
      : `AND LOWER(d.data->>'agent_name') = LOWER(${this.escapeSql(ctx.agentName)})`;
    const res = await this.query(`
      SELECT d.document_id, d.data, d.created_at, d.updated_at
      FROM vibe.documents d
      WHERE d.client_id = ${clientId}
        AND d.collection = ${this.escapeSql(COLLECTION)}
        AND d.table_name = ${this.escapeSql(TABLE_NAME)}
        AND (d.data->>'document_id')::INTEGER = ${Number(id)}
        AND COALESCE((d.data->>'is_deleted')::BOOLEAN, FALSE) = FALSE
        ${agentClause}
      ORDER BY d.created_at DESC
      LIMIT 1
    `);

    const row = res.data?.[0];
    if (!row) return null;
    return this.rowToDoc(row);
  }

  async updateDocument(id: number, updates: UpdateFields): Promise<AgentDocument | null> {
    const { clientId, userId } = await this.resolveContext(updates);

    const existing = await this.getDocument(id, updates);
    if (!existing) return null;

    const nextRes = await this.query(`
      SELECT COALESCE(MAX(CAST(d.data->>'document_id' AS INTEGER)), 0) + 1 AS next_id
      FROM vibe.documents d
      WHERE d.client_id = ${clientId}
        AND d.collection = ${this.escapeSql(COLLECTION)}
        AND d.table_name = ${this.escapeSql(TABLE_NAME)}
    `);
    const nextId = nextRes.data?.[0]?.next_id ?? 1;

    const newVersion = (existing.version || 1) + 1;
    const now = new Date().toISOString();
    const title = updates.title ?? existing.title;
    const content = updates.content_md ?? existing.content_md;
    const docType = (updates.document_type ?? existing.type).toLowerCase();

    const dataJson = JSON.stringify({
      document_id: nextId,
      agent_name: existing.author_agent || updates.agentName || 'system',
      project_id: existing.project_id,
      title,
      content_md: content,
      blob_storage_key: null,
      doc_type: docType,
      version: newVersion,
      parent_document_id: Number(id),
      content_size_bytes: Buffer.byteLength(content, 'utf8'),
      is_deleted: false,
      created_at: now,
      created_by: userId,
      updated_at: null,
      updated_by: null,
      deleted_at: null,
      deleted_by: null,
    });

    const insertRes = await this.query(`
      INSERT INTO vibe.documents
        (client_id, owner_user_id, collection, table_name, data, created_at, created_by)
      VALUES
        (${clientId}, ${userId}, ${this.escapeSql(COLLECTION)}, ${this.escapeSql(TABLE_NAME)}, ${this.escapeSql(dataJson)}::jsonb, ${this.escapeSql(now)}, ${userId})
      RETURNING document_id, data, created_at
    `);

    const row = insertRes.data?.[0];
    if (!row) throw new Error('VibeSQL did not return updated document');
    return this.rowToDoc(row);
  }

  async deleteDocument(id: number, ctx?: { clientId?: number; userId?: number; agentName?: string }): Promise<boolean> {
    const { clientId, userId } = await this.resolveContext(ctx);

    const now = new Date().toISOString();
    const agentClause = ctx?.agentName === undefined
      ? ''
      : `AND LOWER(d.data->>'agent_name') = LOWER(${this.escapeSql(ctx.agentName)})`;

    const res = await this.query(`
      UPDATE vibe.documents d
      SET
        data = jsonb_set(
          jsonb_set(
            jsonb_set(d.data, '{is_deleted}', 'true'::jsonb),
            '{deleted_at}', ${this.escapeSql(JSON.stringify(now))}::jsonb
          ),
          '{deleted_by}', ${String(userId)}::jsonb
        ),
        deleted_at = ${this.escapeSql(now)}
      WHERE d.client_id = ${clientId}
        AND d.collection = ${this.escapeSql(COLLECTION)}
        AND d.table_name = ${this.escapeSql(TABLE_NAME)}
        AND (d.data->>'document_id')::INTEGER = ${Number(id)}
        ${agentClause}
      RETURNING document_id
    `);

    return (res.data?.length ?? 0) > 0;
  }

  private escapeSql(value: any): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return 'NULL';
      return String(value);
    }
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    return "'" + String(value).replace(/'/g, "''") + "'";
  }
}
