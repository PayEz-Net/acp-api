import { jest } from '@jest/globals';
import { modifySelf } from '../core/modify_self.js';

function createMockManager(session) {
  return {
    load: jest.fn(async () => session ? { session: structuredClone(session), source: 'vibesql' } : null),
    save: jest.fn(async () => {}),
  };
}

const baseSession = {
  sessionId: 'sess_test',
  agentName: 'TestAgent',
  character: 'sage',
  customFunctions: {
    greet: { params: ['name'], body: 'return "Hello " + name;' },
  },
  preferences: { a: 1, b: 2 },
  memory: { tasks: ['task1'] },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1,
};

describe('modifySelf', () => {
  test('throws SESSION_NOT_FOUND when agent does not exist', async () => {
    const manager = createMockManager(null);
    await expect(modifySelf(manager, 'NoAgent', {}))
      .rejects.toMatchObject({ code: 'SESSION_NOT_FOUND', message: expect.stringContaining('Session not found') });
  });

  test('merges preferences with spread', async () => {
    const manager = createMockManager(baseSession);

    const result = await modifySelf(manager, 'TestAgent', {
      preferences: { c: 3 },
    });

    expect(result.session.preferences).toEqual({ a: 1, b: 2, c: 3 });
    expect(result.changes).toContain('preferences');
  });

  test('overwrites existing preference keys', async () => {
    const manager = createMockManager(baseSession);

    const result = await modifySelf(manager, 'TestAgent', {
      preferences: { a: 99 },
    });

    expect(result.session.preferences.a).toBe(99);
    expect(result.session.preferences.b).toBe(2);
  });

  test('null values delete keys after merge', async () => {
    const manager = createMockManager(baseSession);

    const result = await modifySelf(manager, 'TestAgent', {
      preferences: { b: null, d: 4 },
    });

    expect(result.session.preferences).toEqual({ a: 1, d: 4 });
    expect(result.session.preferences.b).toBeUndefined();
  });

  test('arrays are replaced entirely', async () => {
    const manager = createMockManager(baseSession);

    const result = await modifySelf(manager, 'TestAgent', {
      memory: { tasks: ['new1', 'new2'] },
    });

    expect(result.session.memory.tasks).toEqual(['new1', 'new2']);
  });

  test('adds new custom function', async () => {
    const manager = createMockManager(baseSession);

    const result = await modifySelf(manager, 'TestAgent', {
      customFunctions: {
        add: { params: ['a', 'b'], body: 'return a + b;' },
      },
    });

    expect(result.session.customFunctions.greet).toBeDefined();
    expect(result.session.customFunctions.add).toBeDefined();
    expect(result.changes).toContain('customFunctions');
  });

  test('rejects invalid function syntax', async () => {
    const manager = createMockManager(baseSession);

    await expect(modifySelf(manager, 'TestAgent', {
      customFunctions: {
        bad: { params: [], body: 'return {{{;' },
      },
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('SyntaxError') });
  });

  test('rejects function with non-array params', async () => {
    const manager = createMockManager(baseSession);

    await expect(modifySelf(manager, 'TestAgent', {
      customFunctions: {
        bad: { params: 'x', body: 'return x;' },
      },
    })).rejects.toThrow('must be an array');
  });

  test('rejects function with non-string body', async () => {
    const manager = createMockManager(baseSession);

    await expect(modifySelf(manager, 'TestAgent', {
      customFunctions: {
        bad: { params: [], body: 42 },
      },
    })).rejects.toThrow('must be a string');
  });

  test('increments version', async () => {
    const manager = createMockManager(baseSession);

    const result = await modifySelf(manager, 'TestAgent', {
      preferences: { x: 1 },
    });

    expect(result.session.version).toBe(2);
  });

  test('updates updatedAt timestamp', async () => {
    const manager = createMockManager(baseSession);

    const before = new Date().toISOString();
    const result = await modifySelf(manager, 'TestAgent', {
      preferences: { x: 1 },
    });

    expect(result.session.updatedAt >= before).toBe(true);
    expect(result.session.updatedAt).not.toBe(baseSession.updatedAt);
  });

  test('saves updated session', async () => {
    const manager = createMockManager(baseSession);

    await modifySelf(manager, 'TestAgent', { preferences: { x: 1 } });

    expect(manager.save).toHaveBeenCalledTimes(1);
    const saved = manager.save.mock.calls[0][0];
    expect(saved.version).toBe(2);
  });

  test('returns only changed top-level keys', async () => {
    const manager = createMockManager(baseSession);

    const result = await modifySelf(manager, 'TestAgent', {
      preferences: { x: 1 },
      memory: { y: 2 },
    });

    expect(result.changes).toEqual(['preferences', 'memory']);
    expect(result.changes).not.toContain('customFunctions');
  });

  test('character can be modified', async () => {
    const manager = createMockManager(baseSession);

    const result = await modifySelf(manager, 'TestAgent', {
      character: 'forge',
    });

    expect(result.session.character).toBe('forge');
    expect(result.changes).toContain('character');
  });

  test('null custom function deletes it', async () => {
    const manager = createMockManager(baseSession);

    const result = await modifySelf(manager, 'TestAgent', {
      customFunctions: { greet: null },
    });

    expect(result.session.customFunctions.greet).toBeUndefined();
  });
});
