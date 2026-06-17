import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { logger, setLogLevel } from '../api/logging/logger.js';

describe('logger redaction', () => {
  let stdoutSpy;
  let stderrSpy;
  let lines;

  beforeEach(() => {
    setLogLevel('debug');
    lines = [];
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  const parseOnly = () => {
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]);
  };

  test('redacts top-level key field (BYOK primary case)', () => {
    logger.info('byok', 'validate attempt', { provider: 'anthropic', key: 'sk-ant-api03-secret' });
    const entry = parseOnly();
    expect(entry.data.provider).toBe('anthropic');
    expect(entry.data.key).toBe('[REDACTED]');
  });

  test('redacts case-insensitively (Authorization, API_KEY, apiKey)', () => {
    logger.info('byok', 'header dump', {
      Authorization: 'Bearer abc',
      API_KEY: 'sk-xyz',
      apiKey: 'sk-123',
    });
    const entry = parseOnly();
    expect(entry.data.Authorization).toBe('[REDACTED]');
    expect(entry.data.API_KEY).toBe('[REDACTED]');
    expect(entry.data.apiKey).toBe('[REDACTED]');
  });

  test('redacts nested fields (headers.x-anthropic-api-key)', () => {
    logger.info('byok', 'upstream call', {
      headers: { 'x-anthropic-api-key': 'sk-ant-leak', 'content-type': 'application/json' },
      status: 401,
    });
    const entry = parseOnly();
    expect(entry.data.headers['x-anthropic-api-key']).toBe('[REDACTED]');
    expect(entry.data.headers['content-type']).toBe('application/json');
    expect(entry.data.status).toBe(401);
  });

  test('redacts inside arrays', () => {
    logger.info('byok', 'batch', {
      items: [{ key: 'sk-1' }, { key: 'sk-2' }],
    });
    const entry = parseOnly();
    expect(entry.data.items[0].key).toBe('[REDACTED]');
    expect(entry.data.items[1].key).toBe('[REDACTED]');
  });

  test('passes through non-sensitive fields unchanged', () => {
    logger.info('byok', 'envelope', {
      provider: 'moonshot',
      user_id: 'u-123',
      response_status: 200,
      request_bytes: 512,
      response_bytes: 1024,
      duration_ms: 340,
    });
    const entry = parseOnly();
    expect(entry.data.provider).toBe('moonshot');
    expect(entry.data.user_id).toBe('u-123');
    expect(entry.data.response_status).toBe(200);
    expect(entry.data.request_bytes).toBe(512);
    expect(entry.data.response_bytes).toBe(1024);
    expect(entry.data.duration_ms).toBe(340);
  });

  test('redacts access_token and refresh_token (IDP hygiene)', () => {
    logger.info('auth', 'token exchange', {
      access_token: 'eyJhbGc...',
      refresh_token: 'rt-xyz',
      expires_in: 3600,
    });
    const entry = parseOnly();
    expect(entry.data.access_token).toBe('[REDACTED]');
    expect(entry.data.refresh_token).toBe('[REDACTED]');
    expect(entry.data.expires_in).toBe(3600);
  });

  test('handles null and undefined safely', () => {
    logger.info('server', 'msg', { a: null, b: undefined, key: null });
    const entry = parseOnly();
    expect(entry.data.a).toBeNull();
    expect(entry.data).not.toHaveProperty('b');
    expect(entry.data.key).toBe('[REDACTED]');
  });

  test('emits with no data when data absent', () => {
    logger.info('server', 'heartbeat');
    const entry = parseOnly();
    expect(entry).not.toHaveProperty('data');
    expect(entry.message).toBe('heartbeat');
  });
});
