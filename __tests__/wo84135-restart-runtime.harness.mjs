// WO #84135 step 1 — PROVE BY RESULT (DotNetPert)
// Mounts the REAL /v1/lifecycle/agents/:name/restart route and asserts that
// the spawn callback body carries the team runtime re-resolved via
// resolveTeamRuntime. Stubs only the two network edges:
//   1. cloud GET /v1/projects/:id detail  -> { data:{ project:{ runtime_choice }}}
//   2. Electron callback POST /internal/pty/spawn -> records the body
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

// --- stub global fetch for the two edges
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  // cloud project-detail read used by resolveTeamRuntime
  if (u === `${cfg.vibeApiUrl}/v1/projects/18` && (!opts || opts.method === 'GET' || !opts.method)) {
    return new Response(JSON.stringify({ success: true, data: { project: { id: 18, runtime_choice: PROJECT_RUNTIME }, members: [] } }), { status: 200 });
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
const st = backoff.getOrCreate('QAPert-NightHawk');
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
  const res = await realFetch(`http://127.0.0.1:${port}/v1/lifecycle/agents/QAPert-NightHawk/restart`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const json = await res.json();

  console.log('--- restart HTTP status:', res.status);
  console.log('--- spawn callback body sent to Electron:', JSON.stringify(spawnBody));
  const got = spawnBody && spawnBody.runtime;
  const pass = res.status === 200 && got === PROJECT_RUNTIME;
  console.log(`\nEXPECT runtime=${PROJECT_RUNTIME}  GOT runtime=${got}`);
  console.log(pass ? '\n✅ PASS — restart route forwards the team runtime to the spawn callback' : '\n❌ FAIL');
  server.close();
  process.exit(pass ? 0 : 1);
});
