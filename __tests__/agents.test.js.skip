import { jest } from '@jest/globals';
import { createApp } from '../api/server.js';

let request;
let app;
let mockFetchResponses = [];

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
    port: 0,
    acpLocalSecret: 'test-secret',
  });
});

beforeEach(() => {
  mockFetchResponses = [];
  global.fetch = jest.fn(async () => {
    const response = mockFetchResponses.shift() || { success: true, data: [], meta: { rowCount: 0 } };
    return {
      json: async () => response,
      ok: true,
      status: 200,
    };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  delete global.fetch;
});

function makeVibeResponse(data, rowCount = data.length) {
  return { success: true, data, meta: { rowCount } };
}

function authHeaders(agent = 'DotNetPert') {
  return {
    'Authorization': 'Bearer test-secret',
    'X-ACP-Agent': agent,
  };
}

// ── GET /v1/agents/startup-config ──────────────────────────────────────────

describe('GET /v1/agents/startup-config', () => {
  test('returns active agents sorted by startup_order', async () => {
    mockFetchResponses.push(makeVibeResponse([
      { id: 2, name: 'BAPert', display_name: 'BA', role: 'ba', is_active: true, startup_order: 1 },
      { id: 1, name: 'Aurum', display_name: 'Arch', role: 'arch', is_active: true, startup_order: 2 },
    ]));

    const res = await request(app).get('/v1/agents/startup-config').set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.agents).toHaveLength(2);
    expect(res.body.data.agents[0].name).toBe('BAPert');
    expect(res.body.data.agents[1].name).toBe('Aurum');
  });

  test('returns empty array when no active agents', async () => {
    mockFetchResponses.push(makeVibeResponse([]));
    const res = await request(app).get('/v1/agents/startup-config').set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.data.agents).toHaveLength(0);
  });
});

// ── PATCH /v1/agents/:id/activation ────────────────────────────────────────

describe('PATCH /v1/agents/:id/activation', () => {
  test('updates is_active and startup_order', async () => {
    mockFetchResponses.push(makeVibeResponse([
      { id: 1, name: 'Aurum', is_active: false, startup_order: 5 },
    ]));

    const res = await request(app)
      .patch('/v1/agents/1/activation')
      .set(authHeaders())
      .send({ is_active: false, startup_order: 5 });

    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(false);
    expect(res.body.data.startupOrder).toBe(5);
  });

  test('rejects missing is_active', async () => {
    const res = await request(app)
      .patch('/v1/agents/1/activation')
      .set(authHeaders())
      .send({ startup_order: 3 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('rejects negative startup_order', async () => {
    const res = await request(app)
      .patch('/v1/agents/1/activation')
      .set(authHeaders())
      .send({ is_active: true, startup_order: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 404 for unknown agent', async () => {
    mockFetchResponses.push(makeVibeResponse([]));
    const res = await request(app)
      .patch('/v1/agents/999/activation')
      .set(authHeaders())
      .send({ is_active: true });
    expect(res.status).toBe(404);
  });
});

// ── DELETE /v1/agents/:id ──────────────────────────────────────────────────

describe('DELETE /v1/agents/:id', () => {
  test('soft-deletes agent', async () => {
    mockFetchResponses.push(makeVibeResponse([{ id: 1, name: 'Aurum' }]));
    mockFetchResponses.push(makeVibeResponse([]));

    const res = await request(app).delete('/v1/agents/1').set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
  });

  test('returns 404 for unknown agent', async () => {
    mockFetchResponses.push(makeVibeResponse([]));
    const res = await request(app).delete('/v1/agents/999').set(authHeaders());
    expect(res.status).toBe(404);
  });
});

// ── POST /v1/agents/hire ───────────────────────────────────────────────────

describe('POST /v1/agents/hire', () => {
  test('creates agent from body fields', async () => {
    mockFetchResponses.push(makeVibeResponse([])); // existing check
    mockFetchResponses.push(makeVibeResponse([
      { id: 7, name: 'DevOpsPert', display_name: 'DevOps', role: 'devops', is_active: true },
    ]));

    const res = await request(app)
      .post('/v1/agents/hire')
      .set(authHeaders())
      .send({ name: 'DevOpsPert', display_name: 'DevOps', is_active: true, role: 'devops' });

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('DevOpsPert');
  });

  test('creates agent from template_name with fallback fields', async () => {
    mockFetchResponses.push(makeVibeResponse([])); // existing name check empty
    // Pool query returns a matching template
    mockFetchResponses.push(makeVibeResponse([
      { data: JSON.stringify({ name: 'architect', display_name: 'Architect', description: 'Arch desc', model: 'opus', tools_json: ['Read'] }) },
    ]));
    mockFetchResponses.push(makeVibeResponse([
      { id: 8, name: 'ArchPert', display_name: 'Architect', role: 'arch', is_active: true },
    ]));

    const res = await request(app)
      .post('/v1/agents/hire')
      .set(authHeaders())
      .send({ name: 'ArchPert', template_name: 'architect', is_active: true });

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('ArchPert');
  });

  test('falls back to body fields when template_name not found', async () => {
    mockFetchResponses.push(makeVibeResponse([])); // existing check empty
    mockFetchResponses.push(makeVibeResponse([])); // pool query returns nothing
    mockFetchResponses.push(makeVibeResponse([
      { id: 9, name: 'CustomPert', display_name: 'Custom', role: 'custom', is_active: true },
    ]));

    const res = await request(app)
      .post('/v1/agents/hire')
      .set(authHeaders())
      .send({ name: 'CustomPert', template_name: 'nonexistent', is_active: true, role: 'custom' });

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('CustomPert');
  });

  test('returns 409 when name exists', async () => {
    mockFetchResponses.push(makeVibeResponse([{ id: 1 }]));
    const res = await request(app)
      .post('/v1/agents/hire')
      .set(authHeaders())
      .send({ name: 'Aurum', is_active: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  test('rejects missing name', async () => {
    const res = await request(app)
      .post('/v1/agents/hire')
      .set(authHeaders())
      .send({ display_name: 'NoName', is_active: true });
    expect(res.status).toBe(400);
  });
});

// ── PUT /v1/agents/startup-order ───────────────────────────────────────────

describe('PUT /v1/agents/startup-order', () => {
  test('bulk updates startup order', async () => {
    mockFetchResponses.push(makeVibeResponse([]));

    const res = await request(app)
      .put('/v1/agents/startup-order')
      .set(authHeaders())
      .send({ order: [{ agent_id: 1, startup_order: 0 }, { agent_id: 2, startup_order: 1 }] });

    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBe(2);
  });

  test('returns 500 when VibeSQL update fails', async () => {
    mockFetchResponses.push({ success: false, error: { message: 'plpgsql error' }, data: [] });

    const res = await request(app)
      .put('/v1/agents/startup-order')
      .set(authHeaders())
      .send({ order: [{ agent_id: 1, startup_order: 0 }] });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  test('rejects empty order array', async () => {
    const res = await request(app)
      .put('/v1/agents/startup-order')
      .set(authHeaders())
      .send({ order: [] });
    expect(res.status).toBe(400);
  });

  test('rejects negative startup_order', async () => {
    const res = await request(app)
      .put('/v1/agents/startup-order')
      .set(authHeaders())
      .send({ order: [{ agent_id: 1, startup_order: -1 }] });
    expect(res.status).toBe(400);
  });
});

// ── PUT /v1/agents/:id/capabilities ────────────────────────────────────────

describe('PUT /v1/agents/:id/capabilities', () => {
  test('updates capabilities JSONB', async () => {
    mockFetchResponses.push(makeVibeResponse([
      { id: 1, name: 'Aurum', capabilities: '{"write_code":true}' },
    ]));

    const res = await request(app)
      .put('/v1/agents/1/capabilities')
      .set(authHeaders())
      .send({ capabilities: { write_code: true } });

    expect(res.status).toBe(200);
  });

  test('rejects non-object capabilities', async () => {
    const res = await request(app)
      .put('/v1/agents/1/capabilities')
      .set(authHeaders())
      .send({ capabilities: ['not', 'an', 'object'] });
    expect(res.status).toBe(400);
  });
});

// ── PUT /v1/agents/:id/safety-rules ────────────────────────────────────────

describe('PUT /v1/agents/:id/safety-rules', () => {
  test('updates safety_rules JSONB', async () => {
    mockFetchResponses.push(makeVibeResponse([
      { id: 1, name: 'Aurum', safety_rules: '[{"id":"sr1","enabled":true}]' },
    ]));

    const res = await request(app)
      .put('/v1/agents/1/safety-rules')
      .set(authHeaders())
      .send({ safety_rules: [{ id: 'sr1', name: 'Rule 1', description: 'Desc', enabled: true }] });

    expect(res.status).toBe(200);
  });

  test('rejects non-array safety_rules', async () => {
    const res = await request(app)
      .put('/v1/agents/1/safety-rules')
      .set(authHeaders())
      .send({ safety_rules: { not: 'array' } });
    expect(res.status).toBe(400);
  });
});

// ── POST /v1/agents/init-project ───────────────────────────────────────────

describe('POST /v1/agents/init-project', () => {
  const jwtPayload = { email: 'jon@example.com', sub: '13' };
  const jwtToken = `header.${Buffer.from(JSON.stringify(jwtPayload)).toString('base64url')}.signature`;

  test('creates project on first call (201)', async () => {
    mockFetchResponses.push(makeVibeResponse([])); // no existing project
    mockFetchResponses.push(makeVibeResponse([{ id: 42 }])); // create project
    // 2 default agents exist (BAPert + QAPert)
    for (let i = 0; i < 2; i++) {
      mockFetchResponses.push(makeVibeResponse([{ id: i + 1, name: `Agent${i}`, display_name: `Agent ${i}` }]));
    }

    const res = await request(app)
      .post('/v1/agents/init-project')
      .set({ Authorization: `Bearer ${jwtToken}` });

    expect(res.status).toBe(201);
    expect(res.body.data.project_name).toBe('jon-project');
    expect(res.body.data.isNewlyCreated).toBe(true);
    expect(res.body.data.agents).toHaveLength(2);
  });

  test('returns existing project on repeat (200)', async () => {
    mockFetchResponses.push(makeVibeResponse([{ id: 42, name: 'jon-project' }]));
    for (let i = 0; i < 2; i++) {
      mockFetchResponses.push(makeVibeResponse([{ id: i + 1, name: `Agent${i}`, display_name: `Agent ${i}` }]));
    }

    const res = await request(app)
      .post('/v1/agents/init-project')
      .set({ Authorization: `Bearer ${jwtToken}` });

    expect(res.status).toBe(200);
    expect(res.body.data.isNewlyCreated).toBe(false);
  });

  test('allows project_name override', async () => {
    mockFetchResponses.push(makeVibeResponse([]));
    mockFetchResponses.push(makeVibeResponse([{ id: 99 }]));
    for (let i = 0; i < 2; i++) {
      mockFetchResponses.push(makeVibeResponse([{ id: i + 1, name: `Agent${i}`, display_name: `Agent ${i}` }]));
    }

    const res = await request(app)
      .post('/v1/agents/init-project')
      .set({ Authorization: `Bearer ${jwtToken}` })
      .send({ project_name: 'custom-project' });

    expect(res.status).toBe(201);
    expect(res.body.data.project_name).toBe('custom-project');
  });

  test('returns 400 when no email and no override', async () => {
    const badJwt = `header.${Buffer.from(JSON.stringify({ sub: '13' })).toString('base64url')}.signature`;
    const res = await request(app)
      .post('/v1/agents/init-project')
      .set({ Authorization: `Bearer ${badJwt}` });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EMAIL_REQUIRED');
  });
});

// ── GET /v1/agents/:identifier/profile ─────────────────────────────────────

describe('GET /v1/agents/:identifier/profile', () => {
  test('looks up by numeric id', async () => {
    mockFetchResponses.push(makeVibeResponse([
      { id: 1, name: 'Aurum', display_name: 'Aurum', role: 'arch', identity_md: '# ID', is_active: true },
    ]));

    const res = await request(app).get('/v1/agents/1/profile').set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Aurum');
  });

  test('looks up by name', async () => {
    mockFetchResponses.push(makeVibeResponse([
      { id: 1, name: 'Aurum', display_name: 'Aurum', role: 'arch', identity_md: '# ID', is_active: true },
    ]));

    const res = await request(app).get('/v1/agents/Aurum/profile').set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Aurum');
  });

  test('looks up by name with apostrophe without double-escaping', async () => {
    mockFetchResponses.push(makeVibeResponse([
      { id: 3, name: "O'Brien", display_name: "O'Brien", role: 'ops', identity_md: '# ID', is_active: true },
    ]));

    const res = await request(app).get("/v1/agents/O'Brien/profile").set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("O'Brien");
  });

  test('falls back to storage for unknown agent', async () => {
    mockFetchResponses.push(makeVibeResponse([]));
    const res = await request(app).get('/v1/agents/DotNetPert/profile').set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('DotNetPert');
  });

  test('returns 404 when agent not found anywhere', async () => {
    mockFetchResponses.push(makeVibeResponse([]));
    const res = await request(app).get('/v1/agents/UnknownAgent/profile').set(authHeaders());
    expect(res.status).toBe(404);
  });
});
