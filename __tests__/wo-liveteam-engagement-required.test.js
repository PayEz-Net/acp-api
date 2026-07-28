/**
 * WO-ACP-LIVE-TEAM-MERGE (ACP-3) — spawn resolvers fail loud when unengaged.
 * Mounts the REAL /v1/lifecycle/agents routes (same approach as the wo11469
 * pin) with a cloud team read returning an EMPTY roster (live-team model:
 * no team engaged = 200 + empty roster, not an error) and asserts:
 *   - POST /:name/spawn  → 409 ENGAGEMENT_REQUIRED, Electron never called.
 *   - POST /:name/restart → 409 ENGAGEMENT_REQUIRED, no kill, no respawn
 *     (a running agent is left untouched when engagement vanishes).
 *   - restart with the agent NOT on a non-empty roster → same 409.
 *   - engaged roster (agent present) → restart proceeds (engaged case
 *     unchanged; deeper override narrowing stays pinned by wo11469).
 * Stubs only the network edges (cloud team/detail reads, Electron callback).
 */
import { jest } from '@jest/globals';
import express from 'express';
import agentLifecycleRoutes from '../api/routes/agentLifecycle.js';
import { BackoffManager } from '../api/lifecycle/backoff.js';
import { setSession } from '../api/auth/tokenManager.js';

// Synthetic far-future JWT carrying client_id so ensureValidToken returns it
// WITHOUT any IDP call, and requireTokenClientId resolves (harness pattern).
function b64url(o) {
  return Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const cfg = { idpUrl: 'http://idp.test', vibeApiUrl: 'http://cloud.test', acpLocalSecret: 'secret' };

const realFetch = globalThis.fetch;
let spawnBodies = [];
let killCalls = [];
let roster = [];

function mountApp(backoff) {
  const app = express();
  app.use(express.json());
  app.use('/v1/lifecycle/agents', agentLifecycleRoutes({
    cfg,
    backoff,
    healthMonitor: { handlePtyExit() {} },
    callbackPort: 9999,
    bootstrap: async () => ({ session: { sessionId: 's-1' }, source: 'test' }),
  }));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Teardown must destroy keep-alive connections, not just stop listening:
// undici (global fetch) holds the test client sockets open, which is what
// hung jest after PASS ("Jest did not exit") without --forceExit.
function shutdown(server) {
  server.closeAllConnections?.();
  server.close();
}

function seededState(backoff) {
  const st = backoff.getOrCreate('NextPert');
  st.projectId = 18;
  st.terminalId = 'existing';
  st.workDir = '/repo';
  st.autoReport = true;
  return st;
}

beforeAll(() => {
  const farExp = Math.floor((Date.now() + 3600_000) / 1000);
  const jwt = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ client_id: '9', exp: farExp, sub: 'test' })}.sig`;
  setSession({ accessToken: jwt, refreshToken: 'r', expiresAt: new Date(Date.now() + 3600_000), userId: '903', email: 'test@test' });
});

beforeEach(() => {
  spawnBodies = [];
  killCalls = [];
  roster = []; // default: UNENGAGED project (empty live roster)
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    // cloud team read used by resolveAgentId / resolveMemberEffort / resolveMemberModel
    if (u === `${cfg.vibeApiUrl}/v1/projects/18/team`) {
      return new Response(JSON.stringify({ success: true, data: { team: roster } }), { status: 200 });
    }
    // cloud project-detail read used by resolveTeamRuntime
    if (u === `${cfg.vibeApiUrl}/v1/projects/18`) {
      return new Response(JSON.stringify({
        success: true,
        data: { project: { id: 18, runtime_choice: 'kimi' } },
      }), { status: 200 });
    }
    if (u.endsWith('/internal/pty/spawn')) {
      spawnBodies.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ terminalId: 't-test-1' }), { status: 200 });
    }
    if (u.endsWith('/internal/pty/kill')) {
      killCalls.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('ACP-3: unengaged project (empty live roster)', () => {
  test('spawn → 409 ENGAGEMENT_REQUIRED, Electron spawn never called', async () => {
    const backoff = new BackoffManager();
    const server = await listen(mountApp(backoff));
    try {
      const port = server.address().port;
      const res = await realFetch(`http://127.0.0.1:${port}/v1/lifecycle/agents/NextPert/spawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workDir: '/repo', runtime: 'kimi', projectId: 18 }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('ENGAGEMENT_REQUIRED');
      expect(body.error.message).toMatch(/no team engaged on project 18/i);
      expect(spawnBodies).toHaveLength(0);
    } finally {
      shutdown(server);
    }
  });

  test('restart → 409 ENGAGEMENT_REQUIRED, no kill, no respawn, no state mutation', async () => {
    const backoff = new BackoffManager();
    const st = seededState(backoff);
    const server = await listen(mountApp(backoff));
    try {
      const port = server.address().port;
      const res = await realFetch(`http://127.0.0.1:${port}/v1/lifecycle/agents/NextPert/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('ENGAGEMENT_REQUIRED');
      // Resolution happens BEFORE the kill: a still-running agent is left up.
      expect(killCalls).toHaveLength(0);
      expect(spawnBodies).toHaveLength(0);
      // P2: an aborted restart must not leave a phantom 'spawning' status —
      // markManualRestart runs only after the guard.
      expect(st.status).toBe('stopped');
    } finally {
      shutdown(server);
    }
  });

  test('restart with the agent NOT on a non-empty roster → same 409', async () => {
    roster = [{ agent_id: 9, agent_name: 'SomeoneElse', effort_override: 'low', model_override: null }];
    const backoff = new BackoffManager();
    seededState(backoff);
    const server = await listen(mountApp(backoff));
    try {
      const port = server.address().port;
      const res = await realFetch(`http://127.0.0.1:${port}/v1/lifecycle/agents/NextPert/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('ENGAGEMENT_REQUIRED');
      expect(killCalls).toHaveLength(0);
      expect(spawnBodies).toHaveLength(0);
    } finally {
      shutdown(server);
    }
  });

  test('spawn with an EXPLICIT numeric agentId still 409s (no bypass)', async () => {
    const backoff = new BackoffManager();
    const server = await listen(mountApp(backoff));
    try {
      const port = server.address().port;
      const res = await realFetch(`http://127.0.0.1:${port}/v1/lifecycle/agents/NextPert/spawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workDir: '/repo', projectId: 18, agentId: 3 }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('ENGAGEMENT_REQUIRED');
      expect(spawnBodies).toHaveLength(0);
    } finally {
      shutdown(server);
    }
  });
});

describe('ACP-3: engaged project unchanged', () => {
  test('restart proceeds when the agent is on the roster', async () => {
    roster = [{ agent_id: 3, agent_name: 'NextPert', effort_override: 'high', model_override: 'k3' }];
    const backoff = new BackoffManager();
    seededState(backoff);
    const server = await listen(mountApp(backoff));
    try {
      const port = server.address().port;
      const res = await realFetch(`http://127.0.0.1:${port}/v1/lifecycle/agents/NextPert/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(200);
      expect(spawnBodies).toHaveLength(1);
      expect(spawnBodies[0].agentId).toBe(3);
      expect(spawnBodies[0].effort).toBe('high');
      expect(spawnBodies[0].model).toBe('k3');
      expect(spawnBodies[0].runtime).toBe('kimi');
    } finally {
      shutdown(server);
    }
  });

  test('spawn with an explicit agentId keeps caller precedence when engaged', async () => {
    roster = [{ agent_id: 3, agent_name: 'NextPert', effort_override: 'high', model_override: 'k3' }];
    const backoff = new BackoffManager();
    const server = await listen(mountApp(backoff));
    try {
      const port = server.address().port;
      const res = await realFetch(`http://127.0.0.1:${port}/v1/lifecycle/agents/NextPert/spawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workDir: '/repo', projectId: 18, agentId: 42 }),
      });
      expect(res.status).toBe(200);
      expect(spawnBodies).toHaveLength(1);
      expect(spawnBodies[0].agentId).toBe(42); // explicit id wins, as before
    } finally {
      shutdown(server);
    }
  });
});
