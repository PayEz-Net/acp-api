import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import { AgentOutputStore, StoredAgentOutputLine } from '../agentOutputStore.js';

describe('AgentOutputStore', () => {
  let dbPath: string;
  let store: AgentOutputStore;

  beforeEach(() => {
    dbPath = `${os.tmpdir()}/agent-output-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
    store = new AgentOutputStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  function line(agent: string, ts: string, projectId = 'p1'): StoredAgentOutputLine {
    return {
      project_id: projectId,
      session_id: 'sess-1',
      agent: agent,
      terminal_id: 't1',
      provider: 'claude',
      line: `line-${ts}`,
      ts,
    };
  }

  it('writes and reads a line', () => {
    store.write(line('BAPert', '2026-07-03T10:00:00.000Z'));
    const rows = store.query({ project_id: 'p1' });
    expect(rows).toHaveLength(1);
    expect(rows[0].agent).toBe('BAPert');
    expect(rows[0].line).toBe('line-2026-07-03T10:00:00.000Z');
  });

  it('queries by since timestamp', () => {
    store.write(line('BAPert', '2026-07-03T10:00:00.000Z'));
    store.write(line('BAPert', '2026-07-03T10:00:01.000Z'));
    store.write(line('BAPert', '2026-07-03T10:00:02.000Z'));
    const rows = store.query({ project_id: 'p1', since: '2026-07-03T10:00:01.000Z' });
    expect(rows.map((r) => r.ts)).toEqual(['2026-07-03T10:00:02.000Z']);
  });

  it('filters by agents', () => {
    store.write(line('BAPert', '2026-07-03T10:00:00.000Z'));
    store.write(line('DotNetPert', '2026-07-03T10:00:01.000Z'));
    const rows = store.query({ project_id: 'p1', agents: ['DotNetPert'] });
    expect(rows).toHaveLength(1);
    expect(rows[0].agent).toBe('DotNetPert');
  });

  it('purges oldest beyond tier event cap', () => {
    const freeTier = { maxEvents: 10, maxDays: 1 };
    const smallStore = new AgentOutputStore(`${dbPath}.free`, freeTier, 1);
    try {
      for (let i = 0; i < 15; i++) {
        smallStore.write(line('BAPert', `2026-07-03T10:00:${String(i).padStart(2, '0')}.000Z`));
      }
      const rows = smallStore.query({ project_id: 'p1' });
      expect(rows.length).toBeLessThanOrEqual(10);
    } finally {
      smallStore.close();
    }
  });

  it('limits query results', () => {
    for (let i = 0; i < 10; i++) {
      store.write(line('BAPert', `2026-07-03T10:00:${String(i).padStart(2, '0')}.000Z`));
    }
    const rows = store.query({ project_id: 'p1', limit: 3 });
    expect(rows).toHaveLength(3);
  });

  it('supports reconnect catch-up query with since + agents + limit', () => {
    store.write(line('BAPert', '2026-07-03T10:00:00.000Z'));
    store.write(line('DotNetPert', '2026-07-03T10:00:01.000Z'));
    store.write(line('BAPert', '2026-07-03T10:00:02.000Z'));
    store.write(line('DotNetPert', '2026-07-03T10:00:03.000Z'));

    const rows = store.query({
      project_id: 'p1',
      since: '2026-07-03T10:00:01.000Z',
      agents: ['DotNetPert'],
      limit: 1,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].agent).toBe('DotNetPert');
    expect(rows[0].ts).toBe('2026-07-03T10:00:03.000Z');
  });
});
