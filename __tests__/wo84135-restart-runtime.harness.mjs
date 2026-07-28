// WO #84135 step 1 — PROVE BY RESULT (DotNetPert)
// Mounts the REAL /v1/lifecycle/agents/:name/restart route and asserts that
// the spawn callback body carries the team runtime re-resolved via
// resolveTeamRuntime. Stubs only the network edges:
//   1. cloud GET /v1/projects/:id detail  -> { data:{ project:{ runtime_choice }}}
//   2. cloud GET /v1/projects/:id/team    -> live roster (ACP-3: the restart
//      now 409s ENGAGEMENT_REQUIRED when the roster is empty / agent absent,
//      so the harness must staff the agent on the roster for the pass case)
//   3. Electron callback POST /internal/pty/spawn -> records the body
// Phase 2 then flips the roster to EMPTY and asserts the 409 fail-loud path
// (no default-spawn) added by ACP-3 (live-team merge 2026-07).
// Run: npx tsx __tests__/wo84135-restart-runtime.harness.mjs
import express from 'express';
import agentLifecycleRoutes from '../api/routes/agentLifecycle.js';
import { BackoffManager } from '../api/lifecycle/backoff.js';
import { setSession } from '../api/auth/tokenManager.js';

// --- synthetic session: valid far-future JWT carrying a client_id claim so
// ensureValidToken returns it WITHOUT any IDP call, and requireTokenClientId resolves.
function b64url(o) { return Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
const farExp = Math.floor((Date.now() + 3600_000) / 1000);
const jwt = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ client_id: '9', exp: farExp, sub: 'harness' })}.sig`;
setSession({ accessToken: jwt, refreshToken: 'r', expiresAt: new Date(Date.now() + 3600_000), userId: '903', email: 'harness@test' });

const cfg = { idpUrl: 'http://idp.test', vibeApiUrl: 'http://cloud.test', acpLocalSecret: 'secret' };

// --- capture state
let spawnBody = null;
const PROJECT_RUNTIME = process.env.RUNTIME || 'kimi'; // the team runtime under test
const AGENT = 'QAPert-NightHawk';
// Live roster under test — staffed in phase 1, emptied in phase 2.
let roster = [{ agent_id: 5, agent_name: AGENT, effort_override: null, model_override: null }];

// --- stub global fetch for the edges
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  // cloud project-detail read used by resolveTeamRuntime
  if (u === `${cfg.vibeApiUrl}/v1/projects/18` && (!opts || opts.method === 'GET' || !opts.method)) {
    return new Response(JSON.stringify({ success: true, data: { project: { id: 18, runtime_choice: PROJECT_RUNTIME }, members: [] } }), { status: 200 });
  }
  // cloud live-roster read used by resolveAgentId / resolveMemberEffort / resolveMemberModel
  if (u === `${cfg.vibeApiUrl}/v1/projects/18/team`) {
    return new Response(JSON.stringify({ success: true, data: { team: roster } }), { status: 200 });
  }
  // Electron callback /internal/pty/spawn — record what the route sends
  if (u.endsWith('/internal/pty/spawn')) {
    spawnBody = JSON.parse(opts.body);
    return new Response(JSON.stringify({ terminalId: 't-harness-1' }), { status: 200 });
  }
  // /internal/pty/kill during restart
  if (u.endsWith('/internal/pty/kill')) {
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  throw new Error(`unexpected fetch: ${u}`);
};

// --- mount the real router with a pre-seeded kimi-team agent
const backoff = new BackoffManager();
const st = backoff.getOrCreate(AGENT);
st.projectId = 18;          // project 18 = kimi team (live data)
st.terminalId = 'existing'; // running -> restart kills then respawns
st.workDir = '/work';
st.autoReport = true;

const app = express();
app.use(express.json());
app.use('/v1/lifecycle/agents', agentLifecycleRoutes({
  cfg,
  backoff,
  healthMonitor: { handlePtyExit() {} },
  callbackPort: 9999,
  bootstrap: async () => ({ session: { sessionId: 's-1' }, source: 'test' }),
}));

const server = app.listen(0, async () => {
  const port = server.address().port;
  const post = () => realFetch(`http://127.0.0.1:${port}/v1/lifecycle/agents/${AGENT}/restart`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

  // ── Phase 1: engaged roster — restart forwards the team runtime. ──────
  const res = await post();
  console.log('--- restart HTTP status:', res.status);
  console.log('--- spawn callback body sent to Electron:', JSON.stringify(spawnBody));
  const got = spawnBody && spawnBody.runtime;
  const pass1 = res.status === 200 && got === PROJECT_RUNTIME;
  console.log(`\nEXPECT runtime=${PROJECT_RUNTIME}  GOT runtime=${got}`);
  console.log(pass1 ? '✅ PASS(1) — restart route forwards the team runtime to the spawn callback' : '❌ FAIL(1)');

  // ── Phase 2 (ACP-3): roster emptied (team disengaged) — restart must
  // 409 ENGAGEMENT_REQUIRED and never default-spawn. ─────────────────────
  roster = [];
  spawnBody = null;
  st.terminalId = 'existing';
  st.status = 'running';
  const res2 = await post();
  const json2 = await res2.json().catch(() => ({}));
  console.log('--- unengaged restart HTTP status:', res2.status, 'code:', json2?.error?.code);
  const pass2 = res2.status === 409 && json2?.error?.code === 'ENGAGEMENT_REQUIRED' && spawnBody === null;
  console.log(pass2 ? '✅ PASS(2) — unengaged project fails loud (409 ENGAGEMENT_REQUIRED), no default-spawn' : '❌ FAIL(2)');

  // Destroy keep-alive sockets before exit, and let the loop turn once —
  // undici holds the test client connections open, and an immediate
  // process.exit races their teardown (libuv UV_HANDLE_CLOSING assertion
  // on Windows).
  server.closeAllConnections?.();
  server.close(() => setTimeout(() => process.exit(pass1 && pass2 ? 0 : 1), 250));
});
