// Terminal Replay v1 — AC3: local replay API contract backed by PayEzVibe API history.
//
// Verifies the three terminal replay routes exist and honor the contract when
// proxied/aggregated over the backend GET /v1/agent-output/history endpoint:
//   GET /v1/terminal/replay   (filters, chronological order, cursor pagination)
//   GET /v1/terminal/sessions (distinct agent/terminal/session tuples)
//   GET /v1/terminal/export   (NDJSON / JSON streamed download)
//
// Run: npx tsx __tests__/terminal-replay-v1-replay-api.harness.mjs

import express from 'express';
import http from 'http';
import terminalReplayRoutes from '../api/routes/terminalReplay.js';
import { setSession, clearSession } from '../api/auth/tokenManager.js';

function makeFakeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

function line(agent, terminalId, sessionId, ts, projectId = '42') {
  return {
    project_id: projectId,
    session_id: sessionId,
    agent,
    terminal_id: terminalId,
    provider: 'claude',
    line: `${agent}:${terminalId}:${ts}`,
    ts,
  };
}

async function run() {
  const historyRows = [
    line('BAPert', 't1', 's1', '2026-07-15T10:00:00.000Z'),
    line('BAPert', 't1', 's1', '2026-07-15T10:00:01.000Z'),
    line('DotNetPert', 't2', 's2', '2026-07-15T10:00:02.000Z'),
    line('DotNetPert', 't2', 's2', '2026-07-15T10:00:03.000Z'),
    line('BAPert', 't1', 's1', '2026-07-15T10:00:04.000Z'),
  ];

  // Mock PayEzVibe API backend history endpoint.
  const backend = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/agent-output/history')) {
      const url = new URL(req.url, 'http://127.0.0.1');
      const projectId = url.searchParams.get('projectId');
      const agents = url.searchParams.get('agents');
      const sessionId = url.searchParams.get('sessionId');
      const cursor = url.searchParams.get('cursor');
      const limit = Number(url.searchParams.get('limit') || '500');

      let rows = historyRows;
      if (projectId) rows = rows.filter((r) => String(r.project_id) === projectId);
      if (agents) rows = rows.filter((r) => agents.split(',').includes(r.agent));
      if (sessionId) rows = rows.filter((r) => r.session_id === sessionId);

      const offset = cursor ? Number(Buffer.from(cursor, 'base64').toString('utf8')) : 0;
      const page = rows.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      const nextCursor = nextOffset < rows.length ? Buffer.from(String(nextOffset)).toString('base64') : undefined;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { lines: page, next_cursor: nextCursor } }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ success: false }));
  });

  await new Promise((resolve) => backend.listen(0, resolve));
  const backendPort = backend.address().port;
  const backendUrl = `http://127.0.0.1:${backendPort}`;

  const token = makeFakeJwt({ exp: 9999999999, client_id: 'test-client' });
  setSession({
    accessToken: token,
    refreshToken: 'refresh',
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    userId: 'user-1',
    email: 'test@example.com',
  });

  const cfg = {
    idpUrl: 'http://127.0.0.1:9999',
    vibeApiUrl: backendUrl,
    acpLocalSecret: 'test-secret',
    nodeEnv: 'test',
    port: 0,
    host: '127.0.0.1',
    acpCallbackPort: 9998,
    acpAgents: [],
    corsOrigins: [],
    logLevel: 'error',
    vibeConnectionString: '',
    enableContractors: false,
    externalApiUrl: '',
  };

  const app = express();
  app.use(express.json());
  app.use('/v1/terminal', terminalReplayRoutes(cfg));

  const server = app.listen(0, async () => {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}/v1/terminal`;
    const failures = [];

    // --- /v1/terminal/replay
    const replayRes = await fetch(`${base}/replay?project_id=42&agents=BAPert&limit=2`);
    if (replayRes.status !== 200) {
      failures.push(`/v1/terminal/replay returned ${replayRes.status}`);
    } else {
      const replay = await replayRes.json();
      if (!replay.success) failures.push('replay response envelope success=false');
      const lines = replay.data?.lines;
      if (!Array.isArray(lines)) {
        failures.push('replay response missing data.lines array');
      } else {
        if (lines.length !== 2) failures.push(`expected 2 replay lines, got ${lines.length}`);
        if (lines.some((r) => r.agent !== 'BAPert')) failures.push('replay agent filter ignored');
        if (lines[0]?.ts > lines[1]?.ts) failures.push('replay lines not chronological');
        if (!replay.data?.next_cursor) failures.push('replay response missing next_cursor');
      }
    }

    // --- /v1/terminal/sessions
    const sessionsRes = await fetch(`${base}/sessions?project_id=42`);
    if (sessionsRes.status !== 200) {
      failures.push(`/v1/terminal/sessions returned ${sessionsRes.status}`);
    } else {
      const sessions = await sessionsRes.json();
      if (!sessions.success) failures.push('sessions response envelope success=false');
      const list = sessions.data?.sessions;
      if (!Array.isArray(list)) {
        failures.push('sessions response missing data.sessions array');
      } else {
        const keys = list.map((s) => `${s.agent}|${s.terminal_id}|${s.session_id}`).sort();
        const expected = ['BAPert|t1|s1', 'DotNetPert|t2|s2'].sort();
        if (JSON.stringify(keys) !== JSON.stringify(expected)) {
          failures.push(`sessions tuples mismatch: ${JSON.stringify(keys)}`);
        }
      }
    }

    // --- /v1/terminal/export (ndjson)
    const exportRes = await fetch(`${base}/export?project_id=42&format=ndjson`);
    if (exportRes.status !== 200) {
      failures.push(`/v1/terminal/export returned ${exportRes.status}`);
    } else {
      const body = await exportRes.text();
      const exportedLines = body.split('\n').filter(Boolean);
      if (exportedLines.length !== 5) failures.push(`expected 5 exported ndjson lines, got ${exportedLines.length}`);
      const first = exportedLines[0] ? JSON.parse(exportedLines[0]) : null;
      if (!first || !first.agent || !first.terminal_id || !first.ts) {
        failures.push('exported ndjson line missing required fields');
      }
    }

    clearSession();
    server.close();
    backend.close();

    if (failures.length === 0) {
      console.log('\n✅ PASS — local replay API contract satisfied via backend history');
      process.exit(0);
    } else {
      console.log('\n❌ FAIL');
      failures.forEach((f) => console.log(`   • ${f}`));
      process.exit(1);
    }
  });
}

run().catch((err) => {
  console.error('Harness error:', err);
  process.exit(1);
});
