import { createApp } from '../api/server.js';

let request;
let app;

beforeAll(async () => {
  const supertest = await import('supertest');
  request = supertest.default;
  app = await createApp({
    vibesqlUrl: 'http://localhost:0',
    vibeApiUrl: 'http://localhost:0',
    vibeClientId: 1,
    vibeTokenCmd: 'echo {}',
    vibeTokenRefreshS: 300,
    vibeAuthMode: 'bearer',
    vibeSigningKey: '',
    execTimeoutMs: 5000,
    nodeEnv: 'test',
    logLevel: 'error',
    corsOrigins: '*',
    partyTickMs: 999999,
    autonomyMaxRuntimeHours: 4,
    escalationSensitivity: 2,
    acpLocalSecret: 'test-secret',
    port: 0,
  });
});

const authedRequest = () => request.agent(app).set('Authorization', 'Bearer test-secret');

describe('PayEz Envelope', () => {
  test('success responses have required envelope fields', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body).toHaveProperty('operation_code');
    expect(res.body).toHaveProperty('time_stamp');
    expect(res.body).toHaveProperty('request_id');
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(res.body.meta.version).toBe('1.0');
  });

  test('error responses have required envelope fields', async () => {
    const res = await authedRequest().get('/v1/sessions/NonExistent');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toHaveProperty('code');
    expect(res.body.error).toHaveProperty('support');
  });

  test('404 for unknown routes', async () => {
    const res = await authedRequest().get('/v1/unknown');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('Agent Name Validation', () => {
  test('rejects invalid agent names', async () => {
    const res = await authedRequest().post('/v1/agents/a b c/bootstrap');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  test('rejects names over 100 chars', async () => {
    const res = await authedRequest().post(`/v1/agents/${'a'.repeat(101)}/bootstrap`);
    expect(res.status).toBe(400);
  });

  test('accepts valid agent names', async () => {
    const res = await authedRequest().post('/v1/agents/Test_Agent-1/bootstrap');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('Bootstrap', () => {
  test('creates new session', async () => {
    const res = await authedRequest().post('/v1/agents/BootstrapTest/bootstrap');
    expect(res.status).toBe(200);
    expect(res.body.data.session.agentName).toBe('BootstrapTest');
    expect(res.body.data.source).toBe('new');
  });

  test('returns existing session on second call', async () => {
    await authedRequest().post('/v1/agents/BootstrapTwice/bootstrap');
    const res = await authedRequest().post('/v1/agents/BootstrapTwice/bootstrap');
    expect(res.body.data.source).toBe('memory');
  });

  test('applies initial preferences', async () => {
    const res = await authedRequest()
      .post('/v1/agents/PrefAgent/bootstrap')
      .send({ initialPreferences: { theme: 'dark' } });
    expect(res.body.data.session.preferences.theme).toBe('dark');
  });
});

describe('Modify Self', () => {
  test('modifies session functions', async () => {
    await authedRequest().post('/v1/agents/ModifyAgent/bootstrap');
    const res = await authedRequest()
      .post('/v1/agents/ModifyAgent/modify')
      .send({ customFunctions: { greet: { params: ['name'], body: 'return "Hi " + name;' } } });
    expect(res.status).toBe(200);
    expect(res.body.data.session.customFunctions.greet).toBeDefined();
    expect(res.body.data.changes).toContain('customFunctions');
  });

  test('returns 404 for non-existent agent', async () => {
    const res = await authedRequest()
      .post('/v1/agents/GhostAgent/modify')
      .send({ preferences: {} });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  test('returns 400 for invalid function syntax', async () => {
    await authedRequest().post('/v1/agents/BadFuncAgent/bootstrap');
    const res = await authedRequest()
      .post('/v1/agents/BadFuncAgent/modify')
      .send({ customFunctions: { bad: { params: [], body: 'if(' } } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('Exec With Agent', () => {
  test('executes code in agent context', async () => {
    await authedRequest().post('/v1/agents/ExecAgent/bootstrap');
    const res = await authedRequest()
      .post('/v1/agents/ExecAgent/exec')
      .send({ code: 'return 2 + 2;' });
    expect(res.status).toBe(200);
    expect(res.body.data.result).toBe(4);
    expect(res.body.data.executionTimeMs).toBeDefined();
  });

  test('returns 400 without code', async () => {
    await authedRequest().post('/v1/agents/ExecNoCode/bootstrap');
    const res = await authedRequest()
      .post('/v1/agents/ExecNoCode/exec')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  test('returns 404 for non-existent agent', async () => {
    const res = await authedRequest()
      .post('/v1/agents/NoAgent/exec')
      .send({ code: 'return 1;' });
    expect(res.status).toBe(404);
  });
});

describe('Sessions', () => {
  test('lists all sessions as 200 with array', async () => {
    const res = await authedRequest().get('/v1/sessions');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  test('gets session by name', async () => {
    await authedRequest().post('/v1/agents/SessionGet/bootstrap');
    const res = await authedRequest().get('/v1/sessions/SessionGet');
    expect(res.status).toBe(200);
    expect(res.body.data.session.agentName).toBe('SessionGet');
  });

  test('deletes session', async () => {
    await authedRequest().post('/v1/agents/SessionDel/bootstrap');
    const delRes = await authedRequest().delete('/v1/sessions/SessionDel');
    expect(delRes.status).toBe(200);
    expect(delRes.body.data.deleted).toBe('SessionDel');
    const getRes = await authedRequest().get('/v1/sessions/SessionDel');
    expect(getRes.status).toBe(404);
  });
});

describe('Health', () => {
  test('returns health check', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('storage');
    expect(res.body.data).toHaveProperty('filesystem');
  });
});

describe('CORS', () => {
  test('OPTIONS returns 204', async () => {
    const res = await request(app).options('/v1/sessions');
    expect(res.status).toBe(204);
  });
});

describe('X-Request-ID', () => {
  test('uses provided request ID', async () => {
    const res = await request(app)
      .get('/health')
      .set('X-Request-ID', 'custom-id-123');
    expect(res.body.request_id).toBe('custom-id-123');
  });

  test('generates request ID if not provided', async () => {
    const res = await request(app).get('/health');
    expect(res.body.request_id).toBeTruthy();
  });
});
