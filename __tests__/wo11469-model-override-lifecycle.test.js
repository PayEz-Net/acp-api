/**
 * WO 11469 — manual spawn + restart must carry model_override end-to-end.
 * Mounts the REAL /v1/lifecycle/agents routes (same approach as the
 * wo84135 restart-runtime harness) and asserts the Electron spawn callback
 * body carries `model`:
 *   (a) POST /:name/spawn accepts { model } and forwards it un-narrowed.
 *   (b) POST /:name/restart re-resolves model_override FRESH from the cloud
 *       team read via resolveMemberModel (and keeps effort + runtime).
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

const memberRow = {
  agent_id: 3,
  agent_name: 'NextPert',
  agent_display_name: 'NextPert',
  runtime_override: 'kimi',
  effort_override: 'high',
  model_override: 'k3',
};

const realFetch = globalThis.fetch;
let spawnBodies = [];
let teamModelOverride = 'k3';

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

beforeAll(() => {
  const farExp = Math.floor((Date.now() + 3600_000) / 1000);
  const jwt = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ client_id: '9', exp: farExp, sub: 'test' })}.sig`;
  setSession({ accessToken: jwt, refreshToken: 'r', expiresAt: new Date(Date.now() + 3600_000), userId: '903', email: 'test@test' });
});

beforeEach(() => {
  spawnBodies = [];
  teamModelOverride = 'k3';
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    // cloud team read used by resolveMemberEffort / resolveMemberModel / resolveAgentId
    if (u === `${cfg.vibeApiUrl}/v1/projects/18/team`) {
      return new Response(JSON.stringify({
        success: true,
        data: { team: [{ ...memberRow, model_override: teamModelOverride }] },
      }), { status: 200 });
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
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('WO 11469 (a): POST /v1/lifecycle/agents/:name/spawn', () => {
  test('accepts model and forwards it un-narrowed to the Electron callback', async () => {
    const backoff = new BackoffManager();
    const server = await listen(mountApp(backoff));
    try {
      const port = server.address().port;
      const res = await realFetch(`http://127.0.0.1:${port}/v1/lifecycle/agents/NextPert/spawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workDir: '/repo', runtime: 'kimi', effort: 'high', model: 'k3', projectId: 18 }),
      });
      expect(res.status).toBe(200);
      expect(spawnBodies).toHaveLength(1);
      expect(spawnBodies[0].model).toBe('k3');
      expect(spawnBodies[0].effort).toBe('high');
      expect(spawnBodies[0].runtime).toBe('kimi');
    } finally {
      shutdown(server);
    }
  });

  test('omits model when absent or blank (inherit the CLI default)', async () => {
    const backoff = new BackoffManager();
    const server = await listen(mountApp(backoff));
    try {
      const port = server.address().port;
      const res = await realFetch(`http://127.0.0.1:${port}/v1/lifecycle/agents/NextPert/spawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workDir: '/repo', runtime: 'kimi', model: '  ', projectId: 18 }),
      });
      expect(res.status).toBe(200);
      expect(spawnBodies).toHaveLength(1);
      expect('model' in spawnBodies[0]).toBe(false);
    } finally {
      shutdown(server);
    }
  });
});

describe('WO 11469 (b): POST /v1/lifecycle/agents/:name/restart', () => {
  test('re-resolves model_override FRESH from the DB alongside effort and runtime', async () => {
    const backoff = new BackoffManager();
    const st = backoff.getOrCreate('NextPert');
    st.projectId = 18;
    st.terminalId = 'existing';
    st.workDir = '/repo';
    st.autoReport = true;

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
      expect(spawnBodies[0].model).toBe('k3');
      expect(spawnBodies[0].effort).toBe('high');
      expect(spawnBodies[0].runtime).toBe('kimi');
    } finally {
      shutdown(server);
    }
  });

  test('omits model when the member row has model_override null (inherit)', async () => {
    teamModelOverride = null;
    const backoff = new BackoffManager();
    const st = backoff.getOrCreate('NextPert');
    st.projectId = 18;
    st.terminalId = 'existing';
    st.workDir = '/repo';
    st.autoReport = true;

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
      expect('model' in spawnBodies[0]).toBe(false);
      // Effort + runtime still re-resolve independently of model.
      expect(spawnBodies[0].effort).toBe('high');
      expect(spawnBodies[0].runtime).toBe('kimi');
    } finally {
      shutdown(server);
    }
  });
});
