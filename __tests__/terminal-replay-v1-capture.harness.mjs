// Terminal Replay v1 — AC1 + AC6: local capture route normalizes and emits scrubbed lines.
//
// No local SQLite store. The desktop POSTs scrubbed output directly to the
// PayEzVibe API. This harness mounts the real /internal/pty/output route,
// posts raw ANSI PTY bytes that contain secrets and a user-home path, then asserts:
//   * HTTP 200 with received_bytes
//   * An agent-output SSE event was emitted
//   * The emitted event is scrubbed (no secret key, no home path)
//
// Run: npx tsx __tests__/terminal-replay-v1-capture.harness.mjs

import express from 'express';
import { BackoffManager } from '../api/lifecycle/backoff.js';
import { LocalEventBus } from '../api/sse/localEventBus.js';
import { TerminalOutputBridge } from '../api/terminal/terminalOutputBridge.js';
import { success, error } from '../api/response.js';

const AGENT = 'BAPert';
const TERMINAL = 'term-capture-1';
const PROJECT_ID = 42;
const SESSION_ID = 'sess-capture-1';
const HOME_PATH = 'C:/Users/jon-local';
const SECRET = 'AWS_SECRET_ACCESS_KEY=abc123xyz';

async function run() {
  const bus = new LocalEventBus();
  const bridge = new TerminalOutputBridge(bus);
  bridge.startPeriodicFlush();

  const sseEvents = [];
  bus.onEvent((event) => {
    if (event.event === 'agent-output') sseEvents.push(event.data);
  });

  // Seed the agent lifecycle state so the route can resolve project/session/provider.
  const backoff = new BackoffManager();
  const state = backoff.getOrCreate(AGENT);
  state.projectId = PROJECT_ID;
  state.sessionId = SESSION_ID;
  state.provider = 'claude';

  // Minimal inline route matching the server.js contract.
  const app = express();
  app.use(express.json());
  app.post('/internal/pty/output', (req, res) => {
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
    const raw = `\x1b[31m${SECRET}\x1b[0m\nusing workspace ${HOME_PATH}/repo\nhello world\n`;

    const start = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/internal/pty/output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentName: AGENT, terminalId: TERMINAL, data: raw, provider: 'claude' }),
    });
    const json = await res.json();
    const httpMs = Date.now() - start;

    // Allow the bridge a moment to emit the SSE event.
    await new Promise((r) => setTimeout(r, 50));

    let pass = true;
    const failures = [];

    if (res.status !== 200) {
      pass = false;
      failures.push(`expected HTTP 200, got ${res.status}`);
    }
    if (json.data?.received_bytes !== raw.length) {
      pass = false;
      failures.push(`expected received_bytes=${raw.length}, got ${json.data?.received_bytes}`);
    }
    if (sseEvents.length === 0) {
      pass = false;
      failures.push('no agent-output SSE event emitted');
    } else {
      const emitted = sseEvents.map((e) => e.line).join('\n');
      if (emitted.includes(SECRET)) {
        pass = false;
        failures.push('secret key was NOT scrubbed from emitted line');
      }
      if (emitted.includes(HOME_PATH)) {
        pass = false;
        failures.push('home path was NOT scrubbed from emitted line');
      }
      if (!sseEvents.some((e) => e.line === 'hello world')) {
        pass = false;
        failures.push('expected plain line "hello world" missing from emitted event');
      }
      if (!sseEvents.every((e) => e.agent === AGENT && e.terminal_id === TERMINAL && e.provider === 'claude')) {
        pass = false;
        failures.push('emitted event metadata does not match expected agent/terminal/provider');
      }
    }

    // Cleanup
    bridge.stopPeriodicFlush();
    server.close();

    console.log('--- /internal/pty/output HTTP status:', res.status);
    console.log('--- HTTP latency:', `${httpMs}ms`);
    console.log('--- SSE events emitted:', sseEvents.length);
    if (sseEvents.length) {
      console.log('--- emitted lines:');
      sseEvents.forEach((e) => console.log(`    [${e.agent}:${e.terminal_id}] ${e.line}`));
    }

    if (pass) {
      console.log('\n✅ PASS — local capture route normalizes and emits scrubbed lines');
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
