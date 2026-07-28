// Terminal Replay v1 — spawn-orchestrator bypass fix.
//
// Verifies that an agent spawned directly by acp-desktop (bypassing
// /v1/lifecycle/agents/:name/spawn) can still be captured locally:
//   * POST /internal/pty/register seeds BackoffManager without a pre-existing state.
//   * POST /internal/pty/output then resolves project_id/session_id correctly.
//   * A normalized agent-output SSE event is emitted.
//
// No local SQLite store. The desktop POSTs directly to PayEzVibe API.
// Run: npx tsx __tests__/terminal-replay-v1-register.harness.mjs

import express from 'express';
import { BackoffManager } from '../api/lifecycle/backoff.js';
import { LocalEventBus } from '../api/sse/localEventBus.js';
import { TerminalOutputBridge } from '../api/terminal/terminalOutputBridge.js';
import { success, error } from '../api/response.js';
import { bootstrap } from '../core/bootstrap.js';

const AGENT = 'BAPert';
const TERMINAL = 'term-register-1';
const PROJECT_ID = 42;
const PROVIDER = 'claude';

class InMemorySessionManager {
  #sessions = new Map();

  async init() { /* no-op */ }

  async load(agentName) {
    return this.#sessions.get(agentName) || null;
  }

  async save(session) {
    this.#sessions.set(session.agentName, session);
  }
}

async function run() {
  const bus = new LocalEventBus();
  const bridge = new TerminalOutputBridge(bus);
  bridge.startPeriodicFlush();

  const sseEvents = [];
  bus.onEvent((event) => {
    if (event.event === 'agent-output') sseEvents.push(event.data);
  });

  // Do NOT pre-seed the agent lifecycle state — this is the bug scenario.
  const backoff = new BackoffManager();
  const sessionManager = new InMemorySessionManager();

  const app = express();
  app.use(express.json());

  // Inline the real /internal/pty/register route contract.
  app.post('/internal/pty/register', async (req, res) => {
    const { agentName, terminalId, projectId, provider } = req.body || {};
    if (!agentName || !terminalId || projectId === undefined || projectId === null) {
      return res.status(400).json(error('INVALID_REQUEST', 'agentName, terminalId, and projectId required', 'pty_register', req.requestId));
    }
    const resolvedProjectId = typeof projectId === 'number' ? projectId : Number(projectId);
    if (!Number.isFinite(resolvedProjectId)) {
      return res.status(400).json(error('INVALID_REQUEST', 'projectId must be a number', 'pty_register', req.requestId));
    }

    try {
      const { session } = await bootstrap(sessionManager, agentName);
      const state = backoff.getOrCreate(agentName);
      state.projectId = resolvedProjectId;
      backoff.markSpawned(agentName, terminalId, session.sessionId, provider || null);

      res.json(success({
        agent_name: agentName,
        terminal_id: terminalId,
        session_id: session.sessionId,
        project_id: resolvedProjectId,
        provider: state.provider,
      }, 'pty_register', req.requestId));
    } catch (err) {
      console.error('[PTY Register] failed to seed lifecycle state:', err);
      res.status(500).json(error('REGISTER_FAILED', 'Failed to seed agent lifecycle state', 'pty_register', req.requestId));
    }
  });

  // Inline the real /internal/pty/output route contract.
  app.post('/internal/pty/output', async (req, res) => {
    const { agentName, terminalId, data, provider } = req.body || {};
    if (!agentName || !terminalId || typeof data !== 'string') {
      bridge.recordInvalidInput();
      return res.status(400).json(error('INVALID_REQUEST', 'agentName, terminalId, and data string required', 'pty_output', req.requestId));
    }
    const s = backoff.get(agentName);
    if (!s || s.projectId == null || !s.sessionId) {
      bridge.recordInvalidInput();
      return res.status(400).json(error('AGENT_NOT_REGISTERED', 'Agent lifecycle state not found', 'pty_output', req.requestId));
    }
    bridge.push(agentName, terminalId, data, s.provider || provider || 'unknown', String(s.projectId), s.sessionId);
    res.json(success({
      agent_name: agentName,
      terminal_id: terminalId,
      received_bytes: data.length,
    }, 'pty_output', req.requestId));
  });

  const server = app.listen(0, async () => {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const failures = [];

    // Step 1: register the terminal without any pre-seeded BackoffManager state.
    const registerRes = await fetch(`${base}/internal/pty/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentName: AGENT, terminalId: TERMINAL, projectId: PROJECT_ID, provider: PROVIDER }),
    });
    const registerJson = await registerRes.json();

    if (registerRes.status !== 200) {
      failures.push(`register returned ${registerRes.status}: ${registerJson?.error?.message}`);
    } else if (!registerJson.success || !registerJson.data?.session_id) {
      failures.push('register did not return a session_id');
    }

    // Step 2: post PTY output. This would previously fail with AGENT_NOT_REGISTERED.
    const raw = `hello from spawn-orchestrator bypass\n`;
    const outputRes = await fetch(`${base}/internal/pty/output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentName: AGENT, terminalId: TERMINAL, data: raw, provider: PROVIDER }),
    });
    const outputJson = await outputRes.json();

    if (outputRes.status !== 200) {
      failures.push(`output returned ${outputRes.status}: ${outputJson?.error?.message}`);
    }

    // Allow the bridge a moment to emit the SSE event.
    await new Promise((r) => setTimeout(r, 50));

    if (sseEvents.length === 0) {
      failures.push('no agent-output SSE event emitted');
    } else {
      const row = sseEvents[0];
      if (row.agent !== AGENT) failures.push(`event agent mismatch: ${row.agent}`);
      if (row.terminal_id !== TERMINAL) failures.push(`event terminal_id mismatch: ${row.terminal_id}`);
      if (row.provider !== PROVIDER) failures.push(`event provider mismatch: ${row.provider}`);
      if (!row.line.includes('hello from spawn-orchestrator bypass')) failures.push(`event line mismatch: ${row.line}`);
    }

    // Cleanup
    bridge.stopPeriodicFlush();
    server.close();

    console.log('--- /internal/pty/register status:', registerRes.status);
    console.log('--- /internal/pty/output status:', outputRes.status);
    console.log('--- SSE events emitted:', sseEvents.length);

    if (failures.length === 0) {
      console.log('\n✅ PASS — register seeds lifecycle state and local capture emits SSE');
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
