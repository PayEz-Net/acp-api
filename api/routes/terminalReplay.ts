/**
 * Terminal Replay API.
 *
 * Proxies historical replay queries to the PayEzVibe API backend cache
 * (`GET /v1/agent-output/history`) and implements `/sessions` and `/export`
 * as aggregators over that history. No local persistence.
 */

import { Router, type Request, type Response } from 'express';
import { success, error } from '../response.js';
import { ensureValidToken, requireTokenClientId } from '../auth/tokenManager.js';
import type { Config } from '../../config.js';

const MAX_LIMIT = 5000;
const DEFAULT_LIMIT = 500;
const HISTORY_PATH = '/v1/agent-output/history';

interface HistoryLine {
  agent: string;
  terminal_id: string;
  session_id: string;
  provider: string;
  line: string;
  ts: string;
}

interface HistoryResult {
  lines: HistoryLine[];
  next_cursor?: string;
}

interface BackendHistoryEnvelope {
  success: boolean;
  data?: HistoryResult;
  error?: { code: string; message: string };
}

interface TerminalReplaySession {
  agent: string;
  terminal_id: string;
  session_id: string;
  first_ts: string;
  last_ts: string;
}

function commaSplit(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const split = value.split(',').map((s) => s.trim()).filter(Boolean);
  return split.length > 0 ? split : undefined;
}

function parseProjectId(projectId: string | undefined): number | undefined {
  if (!projectId) return undefined;
  const parsed = Number(projectId);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function buildHistoryQuery(
  projectId: number,
  req: Request,
  extra: { cursor?: string; limit?: number } = {},
): string {
  const params = new URLSearchParams();
  params.set('projectId', String(projectId));

  const agents = commaSplit(req.query.agents as string | undefined);
  if (agents) params.set('agents', agents.join(','));

  const terminals = commaSplit(req.query.terminals as string | undefined);
  if (terminals) params.set('terminals', terminals.join(','));

  const sessionId = (req.query.session_id as string | undefined) || undefined;
  if (sessionId) params.set('sessionId', sessionId);

  const since = (req.query.since as string | undefined) || undefined;
  if (since) params.set('since', since);

  const until = (req.query.until as string | undefined) || undefined;
  if (until) params.set('until', until);

  const limit = extra.limit ?? Math.min(
    Number(req.query.limit as string | undefined) || DEFAULT_LIMIT,
    MAX_LIMIT,
  );
  params.set('limit', String(limit));

  if (extra.cursor) params.set('cursor', extra.cursor);

  return params.toString();
}

async function getCloudHeaders(cfg: Config): Promise<{ headers: Record<string, string>; token: string } | null> {
  const token = await ensureValidToken(cfg.idpUrl, 'terminal-replay');
  if (!token) return null;

  const clientId = requireTokenClientId(token);
  return {
    token,
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-Client-Id': clientId,
      'Content-Type': 'application/json',
    },
  };
}

async function fetchHistoryPage(
  cfg: Config,
  query: string,
  headers: Record<string, string>,
): Promise<HistoryResult> {
  const url = `${cfg.vibeApiUrl}${HISTORY_PATH}?${query}`;
  const res = await fetch(url, { method: 'GET', headers });

  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`upstream HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const envelope = (await res.json()) as BackendHistoryEnvelope;
  if (!envelope.success || !envelope.data) {
    throw new Error(envelope.error?.message || 'upstream returned non-success');
  }

  return envelope.data;
}

async function fetchAllHistory(
  cfg: Config,
  headers: Record<string, string>,
  projectId: number,
  req: Request,
): Promise<HistoryLine[]> {
  const lines: HistoryLine[] = [];
  let cursor: string | undefined;

  do {
    const query = buildHistoryQuery(projectId, req, { cursor, limit: MAX_LIMIT });
    const page = await fetchHistoryPage(cfg, query, headers);
    lines.push(...page.lines);
    cursor = page.next_cursor;
  } while (cursor);

  return lines;
}

export default function terminalReplayRoutes(cfg: Config): Router {
  const router = Router();

  // GET /v1/terminal/replay
  router.get('/replay', async (req: Request, res: Response) => {
    const projectIdValue = parseProjectId(req.query.project_id as string | undefined);
    if (!projectIdValue) {
      res.status(400).json(error('INVALID_REQUEST', 'project_id query parameter is required and must be a positive integer', 'terminal_replay', (req as any).requestId));
      return;
    }

    const auth = await getCloudHeaders(cfg);
    if (!auth) {
      res.status(401).json(error('NOT_AUTHENTICATED', 'No authenticated cloud session available', 'terminal_replay', (req as any).requestId));
      return;
    }

    try {
      const query = buildHistoryQuery(projectIdValue, req);
      const result = await fetchHistoryPage(cfg, query, auth.headers);

      res.json(success({
        lines: result.lines,
        next_cursor: result.next_cursor,
      }, 'terminal_replay', (req as any).requestId));
    } catch (err: any) {
      console.error('[TerminalReplay] replay failed:', err);
      res.status(502).json(error('UPSTREAM_FAILED', err.message || 'Failed to query terminal replay from backend', 'terminal_replay', (req as any).requestId));
    }
  });

  // GET /v1/terminal/sessions
  router.get('/sessions', async (req: Request, res: Response) => {
    const projectIdValue = parseProjectId(req.query.project_id as string | undefined);
    if (!projectIdValue) {
      res.status(400).json(error('INVALID_REQUEST', 'project_id query parameter is required and must be a positive integer', 'terminal_sessions', (req as any).requestId));
      return;
    }

    const auth = await getCloudHeaders(cfg);
    if (!auth) {
      res.status(401).json(error('NOT_AUTHENTICATED', 'No authenticated cloud session available', 'terminal_sessions', (req as any).requestId));
      return;
    }

    try {
      const lines = await fetchAllHistory(cfg, auth.headers, projectIdValue, req);

      const groups = new Map<string, TerminalReplaySession>();
      for (const line of lines) {
        const key = `${line.agent}|${line.terminal_id}|${line.session_id}`;
        const existing = groups.get(key);
        if (!existing) {
          groups.set(key, {
            agent: line.agent,
            terminal_id: line.terminal_id,
            session_id: line.session_id,
            first_ts: line.ts,
            last_ts: line.ts,
          });
        } else {
          if (line.ts < existing.first_ts) existing.first_ts = line.ts;
          if (line.ts > existing.last_ts) existing.last_ts = line.ts;
        }
      }

      const sessions = Array.from(groups.values()).sort((a, b) => (b.last_ts > a.last_ts ? 1 : -1));
      res.json(success({ sessions }, 'terminal_sessions', (req as any).requestId));
    } catch (err: any) {
      console.error('[TerminalReplay] sessions failed:', err);
      res.status(502).json(error('UPSTREAM_FAILED', err.message || 'Failed to query terminal sessions from backend', 'terminal_sessions', (req as any).requestId));
    }
  });

  // GET /v1/terminal/export
  router.get('/export', async (req: Request, res: Response) => {
    const projectIdValue = parseProjectId(req.query.project_id as string | undefined);
    if (!projectIdValue) {
      res.status(400).json(error('INVALID_REQUEST', 'project_id query parameter is required and must be a positive integer', 'terminal_export', (req as any).requestId));
      return;
    }

    const format = (req.query.format as string | undefined) || 'ndjson';
    if (format !== 'json' && format !== 'ndjson') {
      res.status(400).json(error('INVALID_REQUEST', 'format must be "json" or "ndjson"', 'terminal_export', (req as any).requestId));
      return;
    }

    const auth = await getCloudHeaders(cfg);
    if (!auth) {
      res.status(401).json(error('NOT_AUTHENTICATED', 'No authenticated cloud session available', 'terminal_export', (req as any).requestId));
      return;
    }

    try {
      const lines = await fetchAllHistory(cfg, auth.headers, projectIdValue, req);
      const project_id = String(projectIdValue);

      if (format === 'ndjson') {
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Content-Disposition', `attachment; filename="terminal-replay-${project_id}.ndjson"`);
        for (const line of lines) {
          res.write(JSON.stringify(line) + '\n');
        }
        res.end();
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="terminal-replay-${project_id}.json"`);
        res.write(JSON.stringify({ lines }, null, 2));
        res.end();
      }
    } catch (err: any) {
      console.error('[TerminalReplay] export failed:', err);
      res.status(502).json(error('UPSTREAM_FAILED', err.message || 'Failed to export terminal replay from backend', 'terminal_export', (req as any).requestId));
    }
  });

  return router;
}
