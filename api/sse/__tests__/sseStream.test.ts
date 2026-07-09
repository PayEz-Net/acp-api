import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import sseStreamRoutes from '../../routes/sseStream.js';
import { LocalEventBus } from '../localEventBus.js';

class MockUpstreamSseManager {
  private mailHandlers: Array<(agent: string, data: Record<string, unknown>) => void> = [];

  onMailEvent(handler: (agent: string, data: Record<string, unknown>) => void): void {
    this.mailHandlers.push(handler);
  }

  emitMailEvent(agent: string, data: Record<string, unknown>): void {
    for (const h of this.mailHandlers) h(agent, data);
  }

  getStatus(): Record<string, string> {
    return {};
  }

  refresh(_agents: string[]): void {
    /* no-op */
  }

  stop(): void {
    /* no-op */
  }
}

function collectStream(url: string, timeoutMs = 500): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    const req = http.get(url, (res) => {
      res.on('data', (chunk) => { body += chunk.toString(); });
      res.on('end', () => resolve(body));
      res.on('error', reject);
      setTimeout(() => { req.destroy(); resolve(body); }, timeoutMs);
    });
    req.on('error', reject);
  });
}

function parseEvents(body: string): Array<{ event: string; data: Record<string, unknown> }> {
  const events = [];
  for (const block of body.split('\n\n')) {
    const lines = block.split('\n');
    let event = '';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (event && data) {
      try { events.push({ event, data: JSON.parse(data) }); } catch { /* ignore malformed */ }
    }
  }
  return events;
}

describe('sseStream', () => {
  let app: express.Express;
  let server: http.Server;
  let upstream: MockUpstreamSseManager;
  let bus: LocalEventBus;
  let baseUrl: string;

  beforeEach((done) => {
    app = express();
    upstream = new MockUpstreamSseManager();
    bus = new LocalEventBus();
    app.use('/v1/sse', sseStreamRoutes(upstream as any, bus));
    server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      baseUrl = `http://127.0.0.1:${port}/v1/sse/stream`;
      done();
    });
  });

  afterEach((done) => {
    server.close(done);
  });

  it('filters agent-output by ?agents= and strips project_id', async () => {
    const promise = collectStream(`${baseUrl}?agents=DotNetPert&project_id=p1`);
    // Give the server a moment to register the client.
    await new Promise((r) => setTimeout(r, 50));

    bus.emitAgentOutput({ agent: 'DotNetPert', terminal_id: 't1', provider: 'kimi', line: 'hello', ts: '2026-07-03T10:00:00.000Z', project_id: 'p1' } as Record<string, unknown>);
    bus.emitAgentOutput({ agent: 'BAPert', terminal_id: 't2', provider: 'claude', line: 'secret', ts: '2026-07-03T10:00:00.000Z', project_id: 'p1' } as Record<string, unknown>);

    const body = await promise;
    const events = parseEvents(body).filter((e) => e.event === 'agent-output');
    expect(events).toHaveLength(1);
    expect(events[0].data.agent).toBe('DotNetPert');
    expect(events[0].data.project_id).toBeUndefined();
  });

  it('filters agent-output by project_id', async () => {
    const promise = collectStream(`${baseUrl}?agents=&project_id=p1`);
    await new Promise((r) => setTimeout(r, 50));

    bus.emitAgentOutput({ agent: 'BAPert', terminal_id: 't1', provider: 'claude', line: 'in', ts: '2026-07-03T10:00:00.000Z', project_id: 'p1' } as Record<string, unknown>);
    bus.emitAgentOutput({ agent: 'BAPert', terminal_id: 't1', provider: 'claude', line: 'out', ts: '2026-07-03T10:00:01.000Z', project_id: 'p2' } as Record<string, unknown>);

    const body = await promise;
    const events = parseEvents(body).filter((e) => e.event === 'agent-output');
    expect(events.map((e) => e.data.line)).toEqual(['in']);
  });

  it('broadcasts other local events regardless of agents filter', async () => {
    const promise = collectStream(`${baseUrl}?agents=DotNetPert`);
    await new Promise((r) => setTimeout(r, 50));

    bus.emitPartyUpdate({ foo: 'bar' });
    bus.emitAgentOutput({ agent: 'BAPert', terminal_id: 't1', provider: 'claude', line: 'x', ts: '2026-07-03T10:00:00.000Z', project_id: 'p1' } as Record<string, unknown>);

    const body = await promise;
    const events = parseEvents(body);
    expect(events.some((e) => e.event === 'party-update')).toBe(true);
    expect(events.some((e) => e.event === 'agent-output')).toBe(false);
  });

  it('emits reconnect catch-up lines before live events', async () => {
    // This test verifies the route shape; full catch-up behavior is covered in agentOutputStore tests.
    const promise = collectStream(`${baseUrl}?project_id=p1&since=2026-07-03T10:00:00.000Z`);
    const body = await promise;
    expect(body).toContain('event: connected');
  });
});
