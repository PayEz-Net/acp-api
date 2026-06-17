import { jest } from '@jest/globals';
import { escapeSql, escapeJsonb } from '../storage/vibesql_client.js';

describe('escapeSql', () => {
  test('escapes null and undefined to NULL', () => {
    expect(escapeSql(null)).toBe('NULL');
    expect(escapeSql(undefined)).toBe('NULL');
  });

  test('escapes numbers directly', () => {
    expect(escapeSql(42)).toBe('42');
    expect(escapeSql(0)).toBe('0');
    expect(escapeSql(3.14)).toBe('3.14');
  });

  test('escapes non-finite numbers to NULL', () => {
    expect(escapeSql(NaN)).toBe('NULL');
    expect(escapeSql(Infinity)).toBe('NULL');
    expect(escapeSql(-Infinity)).toBe('NULL');
  });

  test('escapes booleans', () => {
    expect(escapeSql(true)).toBe('TRUE');
    expect(escapeSql(false)).toBe('FALSE');
  });

  test('escapes strings with single quotes', () => {
    expect(escapeSql('hello')).toBe('\'hello\'');
    expect(escapeSql('it\'s')).toBe('\'it\'\'s\'');
    expect(escapeSql('O\'Malley\'s')).toBe('\'O\'\'Malley\'\'s\'');
  });

  test('escapes empty string', () => {
    expect(escapeSql('')).toBe('\'\'');
  });
});

describe('escapeJsonb', () => {
  test('escapes objects to JSONB', () => {
    const result = escapeJsonb({ key: 'value' });
    expect(result).toContain('::jsonb');
    expect(result).toContain('"key"');
  });

  test('escapes arrays to JSONB', () => {
    const result = escapeJsonb(['a', 'b']);
    expect(result).toContain('::jsonb');
    expect(result).toContain('"a"');
  });

  test('escapes JSONB values with single quotes', () => {
    const result = escapeJsonb({ key: 'it\'s' });
    expect(result).not.toContain('it\'s\'');
    expect(result).toContain('::jsonb');
  });

  test('handles empty objects', () => {
    expect(escapeJsonb({})).toBe('\'{}\'::jsonb');
  });

  test('handles empty arrays', () => {
    expect(escapeJsonb([])).toBe('\'[]\'::jsonb');
  });
});

describe('VibeSqlClient', () => {
  let VibeSqlClient;
  let mockFetchResponses;

  beforeEach(async () => {
    mockFetchResponses = [];
    global.fetch = jest.fn(async () => {
      const response = mockFetchResponses.shift() || { success: true, rows: [], rowCount: 0 };
      return {
        json: async () => response,
        ok: true,
        status: 200,
      };
    });

    const mod = await import('../storage/vibesql_client.js');
    VibeSqlClient = mod.VibeSqlClient;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete global.fetch;
  });

  test('getSession returns null when no rows', async () => {
    mockFetchResponses.push({ success: true, rows: [], rowCount: 0 });
    const client = new VibeSqlClient({ vibesqlUrl: 'http://localhost:5173' });
    const result = await client.getSession('TestAgent');
    expect(result).toBeNull();
  });

  test('getSession returns session from row', async () => {
    mockFetchResponses.push({
      success: true,
      rows: [{
        session_id: 'sess_123',
        agent_name: 'TestAgent',
        character: 'sage',
        custom_functions: {},
        preferences: {},
        memory: {},
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        version: 1,
      }],
      rowCount: 1,
    });
    const client = new VibeSqlClient({ vibesqlUrl: 'http://localhost:5173' });
    const result = await client.getSession('TestAgent');
    expect(result.agentName).toBe('TestAgent');
    expect(result.sessionId).toBe('sess_123');
    expect(result.character).toBe('sage');
  });

  test('getSession uses instance config URL', async () => {
    mockFetchResponses.push({ success: true, rows: [], rowCount: 0 });
    const client = new VibeSqlClient({ vibesqlUrl: 'http://custom-host:9999' });
    await client.getSession('TestAgent');
    const url = global.fetch.mock.calls[0][0];
    expect(url).toBe('http://custom-host:9999/v1/query');
  });

  test('saveSession calls INSERT for new session', async () => {
    mockFetchResponses.push({ success: true, rows: [], rowCount: 0 });
    mockFetchResponses.push({ success: true, rows: [], rowCount: 0 });

    const client = new VibeSqlClient({ vibesqlUrl: 'http://localhost:5173' });
    await client.saveSession({
      sessionId: 'sess_new',
      agentName: 'NewAgent',
      customFunctions: {},
      preferences: {},
      memory: {},
      version: 1,
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const lastCall = global.fetch.mock.calls[1];
    const body = JSON.parse(lastCall[1].body);
    expect(body.sql).toContain('INSERT INTO agent_sessions');
    expect(body.sql).toContain('NewAgent');
  });

  test('saveSession calls UPDATE for existing session', async () => {
    mockFetchResponses.push({ success: true, rows: [{ id: 1 }], rowCount: 1 });
    mockFetchResponses.push({ success: true, rows: [], rowCount: 0 });

    const client = new VibeSqlClient({ vibesqlUrl: 'http://localhost:5173' });
    await client.saveSession({
      sessionId: 'sess_existing',
      agentName: 'ExistingAgent',
      customFunctions: {},
      preferences: {},
      memory: {},
      version: 2,
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const lastCall = global.fetch.mock.calls[1];
    const body = JSON.parse(lastCall[1].body);
    expect(body.sql).toContain('UPDATE agent_sessions');
  });

  test('listSessions returns mapped rows', async () => {
    mockFetchResponses.push({
      success: true,
      rows: [
        { session_id: 's1', agent_name: 'A1', character: null, custom_functions: {}, preferences: {}, memory: {}, created_at: 'x', updated_at: 'x', version: 1 },
        { session_id: 's2', agent_name: 'A2', character: null, custom_functions: {}, preferences: {}, memory: {}, created_at: 'x', updated_at: 'x', version: 1 },
      ],
      rowCount: 2,
    });

    const client = new VibeSqlClient({ vibesqlUrl: 'http://localhost:5173' });
    const result = await client.listSessions();
    expect(result).toHaveLength(2);
    expect(result[0].agentName).toBe('A1');
    expect(result[1].agentName).toBe('A2');
  });

  test('deleteSession sends DELETE query', async () => {
    mockFetchResponses.push({ success: true, rows: [], rowCount: 0 });

    const client = new VibeSqlClient({ vibesqlUrl: 'http://localhost:5173' });
    await client.deleteSession('TestAgent');

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.sql).toContain('DELETE FROM agent_sessions');
    expect(body.sql).toContain('TestAgent');
  });

  test('_query throws on VibeSQL error', async () => {
    global.fetch = jest.fn(async () => ({
      json: async () => ({
        success: false,
        error: { code: 'INVALID_SQL', message: 'bad query' },
      }),
      ok: true,
      status: 200,
    }));

    const client = new VibeSqlClient({ vibesqlUrl: 'http://localhost:5173' });
    await expect(client._query('BAD SQL')).rejects.toThrow('bad query');
  });
});
