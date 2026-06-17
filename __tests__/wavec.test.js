import { jest } from '@jest/globals';
import { createApp } from '../api/server.js';

let request;
let app;

beforeAll(async () => {
  const supertest = await import('supertest');
  request = supertest.default;
});

beforeEach(async () => {
  jest.spyOn(global, 'setInterval').mockReturnValue(123);
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
    enableContractors: true,
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.ACP_CONTRACTOR_CMD;
  delete process.env.ACP_SKIP_CLI_CHECK;
});

function authHeaders(agent = 'DotNetPert') {
  return {
    'Authorization': 'Bearer test-secret',
    'X-ACP-Agent': agent,
  };
}

// ------------------------------------------------------------------
// AC-1  cli_missing on fresh spawn (hire route)
// ------------------------------------------------------------------

describe('POST /v1/contractors/hire — AC-1 cli_missing', () => {
  test('returns 400 onboarding.cli_missing when CLI not on PATH', async () => {
    process.env.ACP_CONTRACTOR_CMD = 'definitely_not_on_path_xyz_99999';

    const res = await request(app)
      .post('/v1/contractors/hire')
      .set(authHeaders())
      .send({
        profile_name: 'TestContractor',
        assignment: 'Do a thing',
        assigner: 'DotNetPert',
        auto_spawn: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('onboarding.cli_missing');
    expect(res.body.error.message).toContain('CLI not on PATH');
    expect(res.body.error.details).toHaveProperty('expected_cmd', 'definitely_not_on_path_xyz_99999');
    expect(res.body.error.details).toHaveProperty('install_url');
  });

  test('skips check when ACP_SKIP_CLI_CHECK=1', async () => {
    process.env.ACP_CONTRACTOR_CMD = 'definitely_not_on_path_xyz_99999';
    process.env.ACP_SKIP_CLI_CHECK = '1';

    // The hire will proceed past the CLI check but likely fail at service layer
    // because we have no real storage. We just verify it doesn't 400 on CLI.
    const res = await request(app)
      .post('/v1/contractors/hire')
      .set(authHeaders())
      .send({
        profile_name: 'TestContractor',
        assignment: 'Do a thing',
        assigner: 'DotNetPert',
        auto_spawn: true,
      });

    // Should NOT be the CLI missing error
    expect(res.body.error?.code).not.toBe('onboarding.cli_missing');
  });
});

// ------------------------------------------------------------------
// AC-7  cli_missing on reattach (drainQueue)
// ------------------------------------------------------------------

describe('SessionManager drainQueue — AC-7 reattach recheck', () => {
  test('throws CliMissingError when CLI uninstalled since original queue', async () => {
    process.env.ACP_CONTRACTOR_CMD = 'definitely_not_on_path_xyz_99999';

    const { SessionManager } = await import('../api/contractors/sessionManager.js');

    const mockStorage = {
      _query: jest.fn(async (sql) => {
        if (sql.includes("UPDATE agent_contracts SET status = 'expired'")) {
          return { rows: [] };
        }
        if (sql.includes("WHERE c.status = 'queued'")) {
          return {
            rows: [{
              id: 42,
              contractor_agent_id: 7,
              hired_by_agent_id: 1,
              contract_subject: 'Test task',
              profile_source: null,
              conversation_id: 'conv-test-123',
              contractor_name: 'TestContractor',
              hired_by_name: 'DotNetPert',
            }],
          };
        }
        return { rows: [] };
      }),
    };

    const mockEventBus = {
      emit: jest.fn(),
      on: jest.fn(),
    };

    const mockCfg = {};

    const sm = new SessionManager(mockStorage, mockEventBus, mockCfg);

    // drainQueue is private — access via bracket notation
    const drainQueue = sm['drainQueue'].bind(sm);

    await expect(drainQueue()).rejects.toThrow('CLI not on PATH');
    await expect(drainQueue()).rejects.toThrow('definitely_not_on_path_xyz_99999');
  });
});
