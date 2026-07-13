/**
 * Agent output persistence store.
 *
 * Persists normalized, scrubbed terminal output lines to SQLite so reconnecting
 * renderers can catch up on recent history. Raw ANSI PTY chunks are never stored;
 * only lines that have already passed through TerminalOutputBridge normalization
 * and scrubbing are written.
 *
 * Retention is tier-based (QAPert #10575):
 *   - Free:     10,000 events or 7 days
 *   - Pro:      50,000 events or 30 days
 *   - Enterprise: unlimited / custom for MVP
 *
 * Purge runs every 100 inserts OR every 60 seconds, whichever comes first.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface StoredAgentOutputLine {
  project_id: string;
  session_id: string; // metadata only; never used as a query filter
  agent: string;
  terminal_id: string;
  provider: string;
  line: string;
  ts: string; // ISO-8601 UTC
}

export interface AgentOutputQuery {
  project_id: string;
  since?: string; // ISO-8601 UTC
  agents?: string[];
  limit?: number;
}

export interface TierConfig {
  maxEvents: number;
  maxDays: number;
}

const TIER_FREE: TierConfig = { maxEvents: 10_000, maxDays: 7 };
const TIER_PRO: TierConfig = { maxEvents: 50_000, maxDays: 30 };
const TIER_ENTERPRISE: TierConfig = {
  maxEvents: Number.MAX_SAFE_INTEGER,
  maxDays: Number.MAX_SAFE_INTEGER,
};

export function resolveTier(): TierConfig {
  const env = process.env.ACP_TIER ?? 'free';
  switch (env.toLowerCase()) {
    case 'enterprise':
      return TIER_ENTERPRISE;
    case 'pro':
      return TIER_PRO;
    case 'free':
    default:
      return TIER_FREE;
  }
}

export function getDefaultDbPath(): string {
  if (process.env.ACP_AGENT_OUTPUT_DB) {
    return process.env.ACP_AGENT_OUTPUT_DB;
  }
  // Default to acp-api/data/agent-output.sqlite (dev mode)
  return path.resolve(MODULE_DIR, '..', '..', 'data', 'agent-output.sqlite');
}

export class AgentOutputStore {
  private db: Database.Database;
  private tier: TierConfig;
  private readonly purgeIntervalWrites: number;
  private insertCount = 0;
  private seenProjects = new Set<string>();
  private purgeTimer: NodeJS.Timeout | null = null;

  constructor(
    dbPath: string = getDefaultDbPath(),
    tier: TierConfig = resolveTier(),
    purgeIntervalWrites = 100,
    purgeIntervalMs = 60_000,
  ) {
    this.tier = tier;
    this.purgeIntervalWrites = purgeIntervalWrites;

    // Ensure parent directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();

    if (purgeIntervalMs > 0) {
      this.purgeTimer = setInterval(() => this.purgeAll(), purgeIntervalMs);
      if (this.purgeTimer.unref) this.purgeTimer.unref();
    }
  }

  private migrate(): void {
    const migrationPath = path.resolve(MODULE_DIR, '..', '..', 'migrations', '001_init_agent_output.sql');
    if (fs.existsSync(migrationPath)) {
      const sql = fs.readFileSync(migrationPath, 'utf-8');
      this.db.exec(sql);
    } else {
      // Fallback inline schema if migration file is missing
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_output_lines (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          agent TEXT NOT NULL,
          terminal_id TEXT NOT NULL,
          provider TEXT,
          line TEXT NOT NULL,
          ts TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_agent_output_project_ts
          ON agent_output_lines(project_id, ts);

        CREATE INDEX IF NOT EXISTS idx_agent_output_project_agent
          ON agent_output_lines(project_id, agent);
      `);
    }
  }

  write(record: StoredAgentOutputLine): void {
    const stmt = this.db.prepare(`
      INSERT INTO agent_output_lines
        (project_id, session_id, agent, terminal_id, provider, line, ts, created_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      record.project_id,
      record.session_id || 'unknown',
      record.agent,
      record.terminal_id,
      record.provider || 'unknown',
      record.line,
      record.ts,
      new Date().toISOString(),
    );

    this.seenProjects.add(record.project_id);

    if (++this.insertCount >= this.purgeIntervalWrites) {
      this.purge(record.project_id);
      this.insertCount = 0;
    }
  }

  query(options: AgentOutputQuery): StoredAgentOutputLine[] {
    const params: (string | number)[] = [options.project_id];
    let sql = `
      SELECT project_id, session_id, agent, terminal_id, provider, line, ts
      FROM agent_output_lines
      WHERE project_id = ?
    `;

    if (options.since) {
      sql += ` AND ts > ?`;
      params.push(options.since);
    }

    if (options.agents && options.agents.length > 0) {
      const placeholders = options.agents.map(() => '?').join(',');
      sql += ` AND agent IN (${placeholders})`;
      params.push(...options.agents);
    }

    sql += ` ORDER BY ts ASC, id ASC`;

    if (options.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }

    return this.db.prepare(sql).all(...params) as StoredAgentOutputLine[];
  }

  purge(projectId: string): void {
    if (this.tier.maxDays < Number.MAX_SAFE_INTEGER) {
      const ageStmt = this.db.prepare(`
        DELETE FROM agent_output_lines
        WHERE project_id = ? AND created_at < datetime('now', '-${this.tier.maxDays} days')
      `);
      ageStmt.run(projectId);
    }

    if (this.tier.maxEvents < Number.MAX_SAFE_INTEGER) {
      const countStmt = this.db.prepare(`
        DELETE FROM agent_output_lines
        WHERE project_id = ?
          AND id NOT IN (
            SELECT id FROM agent_output_lines
            WHERE project_id = ?
            ORDER BY ts DESC, id DESC
            LIMIT ?
          )
      `);
      countStmt.run(projectId, projectId, this.tier.maxEvents);
    }
  }

  private purgeAll(): void {
    for (const projectId of this.seenProjects) {
      try {
        this.purge(projectId);
      } catch (err) {
        console.warn(`[AgentOutputStore] Periodic purge failed for ${projectId}:`, err);
      }
    }
  }

  close(): void {
    if (this.purgeTimer) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = null;
    }
    this.db.close();
  }
}
