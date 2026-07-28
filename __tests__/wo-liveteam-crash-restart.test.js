/**
 * WO-ACP-LIVE-TEAM-MERGE (ACP-3 / ACP-8) — crash auto-restart must NOT
 * default-spawn on an unengaged project.
 * Drives the REAL crash-restart scheduler (api/lifecycle/crashRestart.ts —
 * the exact code server.js wires into HealthMonitor) with delay=0 and
 * asserts:
 *   - empty live roster (no team engaged) → state.status='error', and the
 *     Electron spawn callback is NEVER called (no silent default-spawn).
 *   - engaged roster (agent present) → respawn proceeds with effort/model/
 *     runtime re-resolved FRESH from the cloud reads.
 * Stubs only the network edges (cloud team/detail reads, Electron callback).
 */
import { jest } from '@jest/globals';
import { makeCrashRestartScheduler } from '../api/lifecycle/crashRestart.js';
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
let roster = [];

function seededState(backoff) {
  const st = backoff.getOrCreate('NextPert');
  st.projectId = 18;
  st.terminalId = null; // crashed
  st.status = 'error';  // what markExited leaves behind
  st.workDir = '/repo';
  st.autoReport = true;
  return st;
}

function makeScheduler(backoff) {
  return makeCrashRestartScheduler({
    cfg,
    backoff,
    callbackPort: 9999,
    bootstrap: async () => ({ session: { sessionId: 's-1' } }),
  });
}

beforeAll(() => {
  const farExp = Math.floor((Date.now() + 3600_000) / 1000);
  const jwt = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ client_id: '9', exp: farExp, sub: 'test' })}.sig`;
  setSession({ accessToken: jwt, refreshToken: 'r', expiresAt: new Date(Date.now() + 3600_000), userId: '903', email: 'test@test' });
});

beforeEach(() => {
  spawnBodies = [];
  roster = []; // default: UNENGAGED project (empty live roster)
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    // cloud team read used by resolveMemberEffort / resolveMemberModel
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
      return new Response(JSON.stringify({ terminalId: 't-crash-1' }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// The scheduler fires on a setTimeout(delay) with an async body — give it a
// few loop turns to finish its cloud reads + (maybe) spawn call.
function settle() {
  return new Promise((r) => setTimeout(r, 100));
}

describe('ACP-3: crash auto-restart on an unengaged project', () => {
  test("sets status='error' and never default-spawns", async () => {
    const backoff = new BackoffManager();
    const st = seededState(backoff);
    makeScheduler(backoff)('NextPert', 0);
    await settle();
    expect(st.status).toBe('error');
    expect(spawnBodies).toHaveLength(0);
  });

  test('agent dropped from the roster (disengaged mid-crash-loop) → same abort', async () => {
    roster = [{ agent_id: 9, agent_name: 'SomeoneElse', effort_override: 'low', model_override: null }];
    const backoff = new BackoffManager();
    const st = seededState(backoff);
    makeScheduler(backoff)('NextPert', 0);
    await settle();
    expect(st.status).toBe('error');
    expect(spawnBodies).toHaveLength(0);
  });
});

describe('ACP-3: crash auto-restart on an engaged project (unchanged)', () => {
  test('respawns with effort/model/runtime re-resolved FRESH', async () => {
    roster = [{ agent_id: 3, agent_name: 'NextPert', effort_override: 'max', model_override: 'k3' }];
    const backoff = new BackoffManager();
    const st = seededState(backoff);
    makeScheduler(backoff)('NextPert', 0);
    await settle();
    expect(spawnBodies).toHaveLength(1);
    expect(spawnBodies[0].effort).toBe('max');
    expect(spawnBodies[0].model).toBe('k3');
    expect(spawnBodies[0].runtime).toBe('kimi');
    expect(st.status).toBe('ready');
    expect(st.terminalId).toBe('t-crash-1');
  });
});
