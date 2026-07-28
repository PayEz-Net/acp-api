/**
 * WO-ACP-LIVE-TEAM-MERGE (ACP-1 / ACP-5 / ACP-6) — live-team proxy coverage.
 * Mounts the REAL /v1/projects + /v1/teams routers and asserts:
 *   (ACP-1) POST /v1/projects/:id/teams engages (200 round-trip, forwards
 *           {team_id} + ?confirm=true) and passes a 409
 *           ENGAGE_CONFIRM_REQUIRED body through VERBATIM.
 *   (ACP-1) GET  /v1/projects/:id/teams + GET /v1/teams passthrough
 *           (teams list preserves server order).
 *   (ACP-5) PUT  /v1/projects/:id/team/:agent_id forwards ONLY whitelisted
 *           override keys (explicit null preserved = clear-to-inherit).
 *   (ACP-6) /v1/teams CRUD + instances + compose map 1:1 onto cloud
 *           /v1/teams (incl. the team-nested instance alias).
 * Stubs only the network edge (global fetch).
 */
import { jest } from '@jest/globals';
import express from 'express';
import projectRoutes from '../api/routes/projects.js';
import teamsRoutes from '../api/routes/teams.js';
import { setSession } from '../api/auth/tokenManager.js';

// Synthetic far-future JWT carrying client_id so ensureValidToken returns it
// WITHOUT any IDP call, and requireTokenClientId resolves (harness pattern).
function b64url(o) {
  return Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const cfg = { idpUrl: 'http://idp.test', vibeApiUrl: 'http://cloud.test', acpLocalSecret: 'secret' };

const realFetch = globalThis.fetch;
let cloudCalls = [];
let engageQueue = [];

const TEAMS_LIST = [
  { id: 5, name: 'Zeta Team', member_count: 3 },
  { id: 2, name: 'Alpha Team', member_count: 2 },
];

function mountApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1/projects', projectRoutes({ emit() {} }, cfg));
  app.use('/v1/teams', teamsRoutes(cfg));
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
  cloudCalls = [];
  engageQueue = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const method = opts?.method || 'GET';
    cloudCalls.push({ url: u, method, body: opts?.body ? JSON.parse(opts.body) : undefined });

    // ACP-1 engage + engagement read (scripted responses per test)
    if (u.startsWith(`${cfg.vibeApiUrl}/v1/projects/7/teams`)) {
      const next = engageQueue.shift();
      if (!next) throw new Error(`unscripted engage fetch: ${method} ${u}`);
      return new Response(JSON.stringify(next.body), { status: next.status });
    }
    // ACP-5 override PUT
    if (u === `${cfg.vibeApiUrl}/v1/projects/7/team/3` && method === 'PUT') {
      return new Response(JSON.stringify({
        success: true,
        data: { team_member: { agent_id: 3, agent_name: 'NextPert', effort_override: 'max' } },
      }), { status: 200 });
    }
    // ACP-6 / ACP-1 standing-team surface
    if (u.startsWith(`${cfg.vibeApiUrl}/v1/teams`)) {
      if (u === `${cfg.vibeApiUrl}/v1/teams` && method === 'GET') {
        return new Response(JSON.stringify({ success: true, data: { teams: TEAMS_LIST } }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('ACP-1: POST /v1/projects/:id/teams (engage)', () => {
  test('200 round-trip forwards {team_id} and passes the cloud body through', async () => {
    const engageBody = {
      success: true,
      data: { engagement: { project_id: 7, team_id: 5, engagement_changed: true, added_agent_ids: [3] } },
    };
    engageQueue.push({ status: 200, body: engageBody });

    const server = await listen(mountApp());
    try {
      const port = server.address().port;
      const res = await realFetch(`http://127.0.0.1:${port}/v1/projects/7/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_id: 5 }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(engageBody);
      expect(cloudCalls).toHaveLength(1);
      expect(cloudCalls[0].method).toBe('POST');
      expect(cloudCalls[0].url).toBe(`${cfg.vibeApiUrl}/v1/projects/7/teams`);
      expect(cloudCalls[0].body).toEqual({ team_id: 5 });
    } finally {
      shutdown(server);
    }
  });

  test('forwards ?confirm=true to cloud', async () => {
    engageQueue.push({ status: 200, body: { success: true, data: { engagement: {} } } });

    const server = await listen(mountApp());
    try {
      const port = server.address().port;
      const res = await realFetch(`http://127.0.0.1:${port}/v1/projects/7/teams?confirm=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_id: 5 }),
      });
      expect(res.status).toBe(200);
      expect(cloudCalls[0].url).toBe(`${cfg.vibeApiUrl}/v1/projects/7/teams?confirm=true`);
    } finally {
      shutdown(server);
    }
  });

  test('409 ENGAGE_CONFIRM_REQUIRED body passes through VERBATIM', async () => {
    const conflictBody = {
      success: false,
      error: {
        code: 'ENGAGE_CONFIRM_REQUIRED',
        current_team: { team_id: 2, name: 'Alpha Team', member_count: 2 },
        incoming_team: { team_id: 5, name: 'Zeta Team', member_count: 3 },
        lost_overrides: [
          { agent_id: 9, role: 'dev', runtime: 'kimi', work_dir: null, is_lead: true },
        ],
        message: 'Engaging Zeta Team replaces Alpha Team; 1 override will be lost.',
      },
    };
    engageQueue.push({ status: 409, body: conflictBody });

    const server = await listen(mountApp());
    try {
      const port = server.address().port;
      const res = await realFetch(`http://127.0.0.1:${port}/v1/projects/7/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_id: 5 }),
      });
      expect(res.status).toBe(409);
      // Byte-for-byte at the JSON level: every key the consent dialog reads
      // (current_team / incoming_team / lost_overrides) arrives untouched.
      expect(await res.json()).toEqual(conflictBody);
    } finally {
      shutdown(server);
    }
  });

  test('400 when team_id is missing (never reaches cloud)', async () => {
    const server = await listen(mountApp());
    try {
      const port = server.address().port;
      const res = await realFetch(`http://127.0.0.1:${port}/v1/projects/7/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(cloudCalls).toHaveLength(0);
    } finally {
      shutdown(server);
    }
  });
});

describe('ACP-1: GET engagement + standing-team reads', () => {
  test('GET /v1/projects/:id/teams passes the cloud body through', async () => {
    const readBody = { success: true, data: { teams: [{ name: 'Zeta Team', team_id: 5, agent_teams_id: 5, id: 5 }] } };
    engageQueue.push({ status: 200, body: readBody });

    const server = await listen(mountApp());
    try {
      const port = server.address().port;
      const res = await realFetch(`http://127.0.0.1:${port}/v1/projects/7/teams`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(readBody);
    } finally {
      shutdown(server);
    }
  });

  test('GET /v1/teams returns the list in server order', async () => {
    const server = await listen(mountApp());
    try {
      const port = server.address().port;
      const res = await realFetch(`http://127.0.0.1:${port}/v1/teams`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.teams).toEqual(TEAMS_LIST); // Zeta first — no re-sorting
    } finally {
      shutdown(server);
    }
  });
});

describe('ACP-5: PUT /v1/projects/:id/team/:agent_id body whitelist', () => {
  test('forwards only whitelisted override keys; explicit null preserved', async () => {
    const server = await listen(mountApp());
    try {
      const port = server.address().port;
      const res = await realFetch(`http://127.0.0.1:${port}/v1/projects/7/team/3`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          effort_override: 'max',
          model_override: null, // clear-to-inherit must survive
          agent_id: 99,         // NOT whitelisted — must be dropped
          display_name: 'x',    // NOT whitelisted — must be dropped
        }),
      });
      expect(res.status).toBe(200);
      expect(cloudCalls).toHaveLength(1);
      expect(cloudCalls[0].body).toEqual({ effort_override: 'max', model_override: null });
    } finally {
      shutdown(server);
    }
  });

  test('upstream 400 flows through with its original code', async () => {
    // Repoint the stub for this one test: blank effort_override → cloud 400.
    const baseFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u === `${cfg.vibeApiUrl}/v1/projects/7/team/3`) {
        return new Response(JSON.stringify({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'effort_override must not be blank' },
        }), { status: 400 });
      }
      return baseFetch(url, opts);
    };

    const server = await listen(mountApp());
    try {
      const port = server.address().port;
      const res = await realFetch(`http://127.0.0.1:${port}/v1/projects/7/team/3`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ effort_override: '' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toBe('effort_override must not be blank');
    } finally {
      shutdown(server);
    }
  });
});

describe('ACP-6: /v1/teams maps 1:1 onto the cloud surface', () => {
  test('compose → POST /v1/teams/compose', async () => {
    const server = await listen(mountApp());
    try {
      const port = server.address().port;
      const res = await realFetch(`http://127.0.0.1:${port}/v1/teams/compose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Team', members: [{ agent_id: 3, is_lead: true }] }),
      });
      expect(res.status).toBe(200);
      expect(cloudCalls[0].url).toBe(`${cfg.vibeApiUrl}/v1/teams/compose`);
      expect(cloudCalls[0].body).toEqual({ name: 'New Team', members: [{ agent_id: 3, is_lead: true }] });
    } finally {
      shutdown(server);
    }
  });

  test('team CRUD paths (get / update / delete)', async () => {
    const server = await listen(mountApp());
    try {
      const port = server.address().port;
      await realFetch(`http://127.0.0.1:${port}/v1/teams/5`);
      await realFetch(`http://127.0.0.1:${port}/v1/teams/5`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      });
      await realFetch(`http://127.0.0.1:${port}/v1/teams/5`, { method: 'DELETE' });
      expect(cloudCalls.map((c) => `${c.method} ${c.url}`)).toEqual([
        `GET ${cfg.vibeApiUrl}/v1/teams/5`,
        `PUT ${cfg.vibeApiUrl}/v1/teams/5`,
        `DELETE ${cfg.vibeApiUrl}/v1/teams/5`,
      ]);
    } finally {
      shutdown(server);
    }
  });

  test('instances: list/add under team; update/delete key by instanceId', async () => {
    const server = await listen(mountApp());
    try {
      const port = server.address().port;
      await realFetch(`http://127.0.0.1:${port}/v1/teams/5/instances`);
      await realFetch(`http://127.0.0.1:${port}/v1/teams/5/instances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: 3, is_lead: true, bogus: 'dropped' }),
      });
      // Team-nested alias (desktop editor shape) → cloud /instances/:id
      await realFetch(`http://127.0.0.1:${port}/v1/teams/5/instances/9`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_lead: false, agent_id: 99 }), // agent_id not in the update DTO → dropped
      });
      await realFetch(`http://127.0.0.1:${port}/v1/teams/5/instances/9`, { method: 'DELETE' });
      expect(cloudCalls.map((c) => `${c.method} ${c.url}`)).toEqual([
        `GET ${cfg.vibeApiUrl}/v1/teams/5/instances`,
        `POST ${cfg.vibeApiUrl}/v1/teams/5/instances`,
        `PUT ${cfg.vibeApiUrl}/v1/teams/instances/9`,
        `DELETE ${cfg.vibeApiUrl}/v1/teams/instances/9`,
      ]);
      // Bodies are whitelisted to the cloud DTO keys.
      expect(cloudCalls[1].body).toEqual({ agent_id: 3, is_lead: true });
      expect(cloudCalls[2].body).toEqual({ is_lead: false });
    } finally {
      shutdown(server);
    }
  });

  test('team create body is whitelisted to the cloud DTO keys', async () => {
    const server = await listen(mountApp());
    try {
      const port = server.address().port;
      const res = await realFetch(`http://127.0.0.1:${port}/v1/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'X', team_type: 'custom', force_refresh: true, bogus: 1 }),
      });
      expect(res.status).toBe(200);
      expect(cloudCalls[0].body).toEqual({ name: 'X', team_type: 'custom' });
    } finally {
      shutdown(server);
    }
  });

  test('list forwards ONLY activeOnly (force_refresh stripped)', async () => {
    const server = await listen(mountApp());
    try {
      const port = server.address().port;
      const res = await realFetch(`http://127.0.0.1:${port}/v1/teams?activeOnly=false&force_refresh=true`);
      expect(res.status).toBe(200);
      expect(cloudCalls[0].url).toBe(`${cfg.vibeApiUrl}/v1/teams?activeOnly=false`);
    } finally {
      shutdown(server);
    }
  });

  test('non-integer teamId → 400, never reaches cloud', async () => {
    const server = await listen(mountApp());
    try {
      const port = server.address().port;
      for (const bad of ['abc', '5abc', '5.5']) {
        const res = await realFetch(`http://127.0.0.1:${port}/v1/teams/${bad}`);
        expect(res.status).toBe(400);
      }
      expect(cloudCalls).toHaveLength(0);
    } finally {
      shutdown(server);
    }
  });
});
