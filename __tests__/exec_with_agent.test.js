import { jest } from '@jest/globals';
import { execWithAgent } from '../core/exec_with_agent.js';

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
    add: { params: ['a', 'b'], body: 'return a + b;' },
    greet: { params: ['name'], body: 'return "Hello " + name;' },
  },
  preferences: { theme: 'dark' },
  memory: { counter: 0 },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1,
};

const testConfig = { execTimeoutMs: 5000 };

describe('execWithAgent', () => {
  test('throws SESSION_NOT_FOUND when agent does not exist', async () => {
    const manager = createMockManager(null);
    await expect(execWithAgent(manager, 'NoAgent', 'return 1;', testConfig))
      .rejects.toMatchObject({ code: 'SESSION_NOT_FOUND', message: expect.stringContaining('Session not found') });
  });

  test('executes simple code and returns result', async () => {
    const manager = createMockManager(baseSession);

    const result = await execWithAgent(manager, 'TestAgent', 'return 1 + 2;', testConfig);
    expect(result.result).toBe(3);
    expect(typeof result.executionTimeMs).toBe('number');
  });

  test('custom functions are available in context', async () => {
    const manager = createMockManager(baseSession);

    const result = await execWithAgent(manager, 'TestAgent', 'return add(3, 4);', testConfig);
    expect(result.result).toBe(7);
  });

  test('multiple custom functions work', async () => {
    const manager = createMockManager(baseSession);

    const result = await execWithAgent(manager, 'TestAgent', 'return greet("World");', testConfig);
    expect(result.result).toBe('Hello World');
  });

  test('preferences are accessible in context', async () => {
    const manager = createMockManager(baseSession);

    const result = await execWithAgent(manager, 'TestAgent', 'return preferences.theme;', testConfig);
    expect(result.result).toBe('dark');
  });

  test('memory is accessible in context', async () => {
    const manager = createMockManager(baseSession);

    const result = await execWithAgent(manager, 'TestAgent', 'return memory.counter;', testConfig);
    expect(result.result).toBe(0);
  });

  test('agentName is accessible in context', async () => {
    const manager = createMockManager(baseSession);

    const result = await execWithAgent(manager, 'TestAgent', 'return agentName;', testConfig);
    expect(result.result).toBe('TestAgent');
  });

  test('JSON is available in context', async () => {
    const manager = createMockManager(baseSession);

    const result = await execWithAgent(manager, 'TestAgent', 'return JSON.stringify({a: 1});', testConfig);
    expect(result.result).toBe('{"a":1}');
  });

  test('Math is available in context', async () => {
    const manager = createMockManager(baseSession);

    const result = await execWithAgent(manager, 'TestAgent', 'return Math.max(1, 5, 3);', testConfig);
    expect(result.result).toBe(5);
  });

  test('require is NOT available (blocked)', async () => {
    const manager = createMockManager(baseSession);

    await expect(
      execWithAgent(manager, 'TestAgent', 'return require("fs");', testConfig)
    ).rejects.toThrow();
  });

  test('process is NOT available (blocked)', async () => {
    const manager = createMockManager(baseSession);

    await expect(
      execWithAgent(manager, 'TestAgent', 'return process.env;', testConfig)
    ).rejects.toThrow();
  });

  test('fetch is NOT available (blocked)', async () => {
    const manager = createMockManager(baseSession);

    await expect(
      execWithAgent(manager, 'TestAgent', 'return fetch("http://evil.com");', testConfig)
    ).rejects.toThrow();
  });

  test('setTimeout is NOT available (blocked)', async () => {
    const manager = createMockManager(baseSession);

    await expect(
      execWithAgent(manager, 'TestAgent', 'return setTimeout(() => {}, 1000);', testConfig)
    ).rejects.toThrow();
  });

  test('execution timeout throws EXECUTION_TIMEOUT', async () => {
    const manager = createMockManager(baseSession);

    await expect(execWithAgent(manager, 'TestAgent', 'while(true) {}', { execTimeoutMs: 50 }))
      .rejects.toMatchObject({ code: 'EXECUTION_TIMEOUT', message: expect.stringContaining('timed out') });
  });

  test('syntax errors in code throw EXECUTION_ERROR', async () => {
    const manager = createMockManager(baseSession);

    await expect(execWithAgent(manager, 'TestAgent', 'return {{{;', testConfig))
      .rejects.toMatchObject({ code: 'EXECUTION_ERROR' });
  });

  test('returns executionTimeMs as a number', async () => {
    const manager = createMockManager(baseSession);

    const result = await execWithAgent(manager, 'TestAgent', 'return 42;', testConfig);
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  test('context is isolated from host globals', async () => {
    const manager = createMockManager(baseSession);

    const result = await execWithAgent(manager, 'TestAgent', 'return typeof process;', testConfig);
    expect(result.result).toBe('undefined');
  });

  test('invalid custom functions are skipped gracefully', async () => {
    const session = {
      ...baseSession,
      customFunctions: {
        good: { params: [], body: 'return 42;' },
        bad: { params: [], body: 'return {{{;' },
      },
    };
    const manager = createMockManager(session);

    const result = await execWithAgent(manager, 'TestAgent', 'return good();', testConfig);
    expect(result.result).toBe(42);
  });
});
