import { jest } from '@jest/globals';
import { PartyEngine } from '../collaboration/party_engine.js';

function createMockStorage(signals = [], mingles = []) {
  return {
    listSignals: jest.fn(async () => structuredClone(signals)),
    listActiveMingles: jest.fn(async () => structuredClone(mingles)),
    createMingle: jest.fn(async () => {}),
    updateMingle: jest.fn(async () => {}),
    upsertSignal: jest.fn(async () => {}),
  };
}

describe('PartyEngine', () => {
  test('start and stop control the tick loop', () => {
    const storage = createMockStorage();
    const engine = new PartyEngine(storage, { partyTickMs: 100000 });
    expect(engine.running).toBe(false);
    engine.start();
    expect(engine.running).toBe(true);
    engine.stop();
    expect(engine.running).toBe(false);
  });

  test('start is idempotent', () => {
    const storage = createMockStorage();
    const engine = new PartyEngine(storage, { partyTickMs: 100000 });
    engine.start();
    engine.start();
    expect(engine.running).toBe(true);
    engine.stop();
  });

  test('tick does nothing with fewer than 2 signals', async () => {
    const storage = createMockStorage([
      { agentId: 'sage', agentName: 'BAPert', zone: 'bar', needs: [], offers: [], keywords: [] },
    ]);
    const engine = new PartyEngine(storage);
    await engine.tick();
    expect(storage.createMingle).not.toHaveBeenCalled();
  });

  test('tick creates mingle when bar agents have high relevance', async () => {
    const signals = [
      { agentId: 'sage', agentName: 'BAPert', zone: 'bar', needs: ['frontend'], offers: ['auth spec'], keywords: ['auth', 'jwt'] },
      { agentId: 'forge', agentName: 'DotNetPert', zone: 'bar', needs: ['auth'], offers: ['frontend'], keywords: ['auth', 'api'] },
    ];
    const storage = createMockStorage(signals);
    const engine = new PartyEngine(storage);
    await engine.tick();
    expect(storage.createMingle).toHaveBeenCalledTimes(1);
    const mingle = storage.createMingle.mock.calls[0][0];
    expect(mingle.agentA).toBe('sage');
    expect(mingle.agentB).toBe('forge');
    expect(mingle.outcome).toBe('pending');
    expect(mingle.mingleId).toMatch(/^mingle_/);
  });

  test('tick does not create mingle for low-relevance agents', async () => {
    const signals = [
      { agentId: 'sage', agentName: 'BAPert', zone: 'bar', needs: ['database'], offers: ['auth'], keywords: ['sql'] },
      { agentId: 'forge', agentName: 'DotNetPert', zone: 'bar', needs: ['css'], offers: ['animation'], keywords: ['react'] },
    ];
    const storage = createMockStorage(signals);
    const engine = new PartyEngine(storage);
    await engine.tick();
    expect(storage.createMingle).not.toHaveBeenCalled();
  });

  test('tick skips agents already in a mingle', async () => {
    const signals = [
      { agentId: 'sage', agentName: 'BAPert', zone: 'bar', needs: ['frontend'], offers: ['auth'], keywords: ['auth'] },
      { agentId: 'forge', agentName: 'DotNetPert', zone: 'bar', needs: ['auth'], offers: ['frontend'], keywords: ['auth'] },
    ];
    const activeMingles = [
      { agentA: 'sage', agentB: 'pixel', interactionType: 'chit_chat', outcome: 'pending', startedAt: new Date().toISOString() },
    ];
    const storage = createMockStorage(signals, activeMingles);
    const engine = new PartyEngine(storage);
    await engine.tick();
    expect(storage.createMingle).not.toHaveBeenCalled();
  });

  test('tick only considers bar/entrance agents for new mingles', async () => {
    const signals = [
      { agentId: 'sage', agentName: 'BAPert', zone: 'table-db', needs: ['frontend'], offers: ['auth'], keywords: ['auth'] },
      { agentId: 'forge', agentName: 'DotNetPert', zone: 'table-api', needs: ['auth'], offers: ['frontend'], keywords: ['auth'] },
    ];
    const storage = createMockStorage(signals);
    const engine = new PartyEngine(storage);
    await engine.tick();
    expect(storage.createMingle).not.toHaveBeenCalled();
  });

  test('tick resolves expired mingles', async () => {
    const expiredTime = new Date(Date.now() - 120000).toISOString();
    const mingles = [
      { mingleId: 'mingle_old', agentA: 'sage', agentB: 'forge', interactionType: 'gossip', outcome: 'pending', startedAt: expiredTime },
    ];
    const storage = createMockStorage([
      { agentId: 'sage', agentName: 'BAPert', zone: 'bar', needs: [], offers: [], keywords: [] },
      { agentId: 'forge', agentName: 'DotNetPert', zone: 'bar', needs: [], offers: [], keywords: [] },
    ], mingles);
    const engine = new PartyEngine(storage);
    await engine.tick();
    expect(storage.updateMingle).toHaveBeenCalledWith('mingle_old', expect.objectContaining({ outcome: 'completed' }));
  });

  test('tick does not resolve fresh mingles', async () => {
    const freshTime = new Date().toISOString();
    const mingles = [
      { mingleId: 'mingle_new', agentA: 'sage', agentB: 'forge', interactionType: 'deep_talk', outcome: 'pending', startedAt: freshTime },
    ];
    const storage = createMockStorage([
      { agentId: 'sage', agentName: 'BAPert', zone: 'bar', needs: [], offers: [], keywords: [] },
      { agentId: 'forge', agentName: 'DotNetPert', zone: 'bar', needs: [], offers: [], keywords: [] },
    ], mingles);
    const engine = new PartyEngine(storage);
    await engine.tick();
    expect(storage.updateMingle).not.toHaveBeenCalled();
  });

  test('tick handles errors gracefully', async () => {
    const storage = createMockStorage();
    storage.listSignals = jest.fn(async () => { throw new Error('db down'); });
    const engine = new PartyEngine(storage);
    await expect(engine.tick()).resolves.not.toThrow();
  });
});
