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

describe('Party Routes — Validation', () => {
  test('POST /v1/party/signal requires agentId and agentName', async () => {
    const res = await authedRequest()
      .post('/v1/party/signal')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  test('POST /v1/party/mingle requires agentA and agentB', async () => {
    const res = await authedRequest()
      .post('/v1/party/mingle')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  test('PUT /v1/party/agents/:id/zone requires zone', async () => {
    const res = await authedRequest()
      .put('/v1/party/agents/sage/zone')
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('Party Routes — Storage-dependent (returns error envelope on no DB)', () => {
  test('GET /v1/party/state returns error envelope when storage unavailable', async () => {
    const res = await authedRequest().get('/v1/party/state');
    expect(res.body).toHaveProperty('success');
    expect(res.body).toHaveProperty('request_id');
    expect(res.body).toHaveProperty('meta');
  });

  test('GET /v1/party/relevance returns error envelope when storage unavailable', async () => {
    const res = await authedRequest().get('/v1/party/relevance');
    expect(res.body).toHaveProperty('success');
    expect(res.body).toHaveProperty('meta');
  });
});

describe('Kanban Routes — Validation', () => {
  test('POST /v1/kanban/tasks requires title', async () => {
    const res = await authedRequest()
      .post('/v1/kanban/tasks')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });
});

describe('Kanban Routes — Storage-dependent', () => {
  test('POST /v1/kanban/tasks returns error envelope on no DB', async () => {
    const res = await authedRequest()
      .post('/v1/kanban/tasks')
      .send({ title: 'Test Task' });
    expect(res.body).toHaveProperty('success');
    expect(res.body).toHaveProperty('meta');
  });

  test('GET /v1/kanban/tasks returns error envelope on no DB', async () => {
    const res = await authedRequest().get('/v1/kanban/tasks');
    expect(res.body).toHaveProperty('success');
    expect(res.body).toHaveProperty('meta');
  });
});

describe('Messaging Routes — Storage-dependent', () => {
  test('POST /v1/messages/broadcast returns error envelope on no DB', async () => {
    const res = await authedRequest()
      .post('/v1/messages/broadcast')
      .send({ fromAgent: 'BAPert', body: 'Test' });
    expect(res.body).toHaveProperty('success');
    expect(res.body).toHaveProperty('meta');
  });

  test('GET /v1/messages/inbox/:agent returns error envelope on no DB', async () => {
    const res = await authedRequest().get('/v1/messages/inbox/BAPert');
    expect(res.body).toHaveProperty('success');
    expect(res.body).toHaveProperty('meta');
  });

  test('GET /v1/messages/broadcasts returns error envelope on no DB', async () => {
    const res = await authedRequest().get('/v1/messages/broadcasts');
    expect(res.body).toHaveProperty('success');
    expect(res.body).toHaveProperty('meta');
  });
});

describe('Autonomy Routes — Storage-dependent', () => {
  test('GET /v1/autonomy/status returns error envelope on no DB', async () => {
    const res = await authedRequest().get('/v1/autonomy/status');
    expect(res.body).toHaveProperty('success');
    expect(res.body).toHaveProperty('meta');
  });

  test('GET /v1/autonomy/standup returns error envelope on no DB', async () => {
    const res = await authedRequest().get('/v1/autonomy/standup');
    expect(res.body).toHaveProperty('success');
    expect(res.body).toHaveProperty('meta');
  });
});

describe('Route Registration', () => {
  test('all collaboration routes are mounted (not 404)', async () => {
    const routes = [
      { method: 'post', path: '/v1/party/signal', body: {} },
      { method: 'get', path: '/v1/party/state' },
      { method: 'get', path: '/v1/party/relevance' },
      { method: 'post', path: '/v1/party/mingle', body: {} },
      { method: 'put', path: '/v1/party/mingle/test/resolve', body: {} },
      { method: 'put', path: '/v1/party/agents/sage/zone', body: {} },
      { method: 'post', path: '/v1/messages/broadcast', body: {} },
      { method: 'post', path: '/v1/messages/mail', body: {} },
      { method: 'get', path: '/v1/messages/inbox/test' },
      { method: 'get', path: '/v1/messages/broadcasts' },
      { method: 'put', path: '/v1/messages/inbox/test/read', body: {} },
      { method: 'post', path: '/v1/kanban/tasks', body: {} },
      { method: 'get', path: '/v1/kanban/tasks' },
      { method: 'get', path: '/v1/kanban/tasks/1' },
      { method: 'put', path: '/v1/kanban/tasks/1/status', body: {} },
      { method: 'put', path: '/v1/kanban/tasks/1/assign', body: {} },
      { method: 'put', path: '/v1/kanban/tasks/1/review', body: {} },
      { method: 'post', path: '/v1/autonomy/start', body: {} },
      { method: 'post', path: '/v1/autonomy/stop', body: {} },
      { method: 'get', path: '/v1/autonomy/status' },
      { method: 'get', path: '/v1/autonomy/standup' },
      { method: 'post', path: '/v1/autonomy/standup', body: {} },
    ];

    for (const route of routes) {
      const req = authedRequest()[route.method](route.path);
      if (route.body) req.send(route.body);
      const res = await req;
      expect(res.body.error?.code).not.toBe('NOT_FOUND');
    }
  });
});

describe('Empty List via Session Routes (file fallback works)', () => {
  test('sessions return 200 with empty array', async () => {
    const res = await authedRequest().get('/v1/sessions');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
