import { jest } from '@jest/globals';
import { bootstrap } from '../core/bootstrap.js';

function createMockManager(existingSession) {
  return {
    load: jest.fn(async () => existingSession),
    save: jest.fn(async () => {}),
  };
}

describe('bootstrap', () => {
  test('returns existing session when found', async () => {
    const existing = {
      session: {
        sessionId: 'sess_existing',
        agentName: 'TestAgent',
        character: 'sage',
        customFunctions: {},
        preferences: {},
        memory: {},
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
      },
      source: 'vibesql',
    };
    const manager = createMockManager(existing);

    const result = await bootstrap(manager, 'TestAgent');
    expect(result.session.sessionId).toBe('sess_existing');
    expect(result.source).toBe('vibesql');
    expect(manager.save).not.toHaveBeenCalled();
  });

  test('creates new session when not found', async () => {
    const manager = createMockManager(null);

    const result = await bootstrap(manager, 'NewAgent');
    expect(result.source).toBe('new');
    expect(result.session.agentName).toBe('NewAgent');
    expect(result.session.sessionId).toMatch(/^sess_/);
    expect(result.session.version).toBe(1);
    expect(result.session.customFunctions).toEqual({});
    expect(result.session.character).toBeNull();
    expect(manager.save).toHaveBeenCalledTimes(1);
  });

  test('applies initial preferences to new session', async () => {
    const manager = createMockManager(null);

    const result = await bootstrap(manager, 'NewAgent', { theme: 'dark', autoSave: true });
    expect(result.session.preferences).toEqual({ theme: 'dark', autoSave: true });
  });

  test('does not apply initial preferences to existing session', async () => {
    const existing = {
      session: {
        sessionId: 'sess_old',
        agentName: 'TestAgent',
        customFunctions: {},
        preferences: { existing: true },
        memory: {},
        version: 3,
      },
      source: 'file',
    };
    const manager = createMockManager(existing);

    const result = await bootstrap(manager, 'TestAgent', { newPref: true });
    expect(result.session.preferences).toEqual({ existing: true });
    expect(result.session.preferences.newPref).toBeUndefined();
  });

  test('new session has valid timestamps', async () => {
    const manager = createMockManager(null);

    const before = new Date().toISOString();
    const result = await bootstrap(manager, 'TimedAgent');
    const after = new Date().toISOString();

    expect(result.session.createdAt >= before).toBe(true);
    expect(result.session.createdAt <= after).toBe(true);
    expect(result.session.createdAt).toBe(result.session.updatedAt);
  });

  test('new session defaults to empty objects', async () => {
    const manager = createMockManager(null);

    const result = await bootstrap(manager, 'DefaultAgent');
    expect(result.session.customFunctions).toEqual({});
    expect(result.session.memory).toEqual({});
  });
});
