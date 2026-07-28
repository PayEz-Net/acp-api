/**
 * SESSION_INACTIVE rewrite (mailProxy) — an upstream 4xx carrying
 * {"error":{"code":"SESSION_INACTIVE","message":"Session is not active"}}
 * must never reach an agent verbatim: agents read "Session is not active" as
 * their own deactivation, go silent, and the poisoned text then persists in
 * the resumed CLI session. The proxy rewrites it to a retryable 503
 * MAIL_UPSTREAM_TRANSIENT whose wording cannot be misread. Other upstream
 * errors still pass through verbatim. Stubs only the network edge
 * (global fetch); client calls go through supertest (Node http) so they are
 * not touched by the stub.
 */
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import mailProxyRoutes from '../api/routes/mailProxy.js';
import { setSession } from '../api/auth/tokenManager.js';

function b64url(o) {
  return Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const cfg = { idpUrl: 'http://idp.test', vibeApiUrl: 'http://cloud.test', acpLocalSecret: 'secret' };

const realFetch = globalThis.fetch;
let upstream = { status: 200, body: { success: true } };

const SESSION_INACTIVE_BODY = {
  success: false,
  error: { code: 'SESSION_INACTIVE', message: 'Session is not active' },
};

function mountApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1/mail', mailProxyRoutes(cfg));
  return app;
}

beforeAll(() => {
  const farExp = Math.floor((Date.now() + 3600_000) / 1000);
  const jwt = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ client_id: '9', exp: farExp, sub: 'test' })}.sig`;
  setSession({ accessToken: jwt, refreshToken: 'r', expiresAt: new Date(Date.now() + 3600_000), userId: '903', email: 'test@test' });
});

beforeEach(() => {
  upstream = { status: 404, body: SESSION_INACTIVE_BODY };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (!u.startsWith(`${cfg.vibeApiUrl}/v1/agentmail/`)) {
      throw new Error(`unexpected fetch: ${u}`);
    }
    return new Response(JSON.stringify(upstream.body), { status: upstream.status });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('SESSION_INACTIVE rewrite', () => {
  it('rewrites upstream SESSION_INACTIVE on POST /send to a retryable 503', async () => {
    const res = await request(mountApp())
      .post('/v1/mail/send')
      .send({ from_agent: 'DotNetPert-Scout', to: ['NextPert'], subject: 'S', body: 'B' });
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('MAIL_UPSTREAM_TRANSIENT');
    // The antidote: explicitly tells the agent it is NOT deactivated...
    expect(res.body.error.message).toMatch(/your agent session is live/i);
    // ...and never carries the phrase that poisoned the resumed session.
    expect(JSON.stringify(res.body)).not.toContain('Session is not active');
  });

  it('rewrites upstream SESSION_INACTIVE on GET /messages/:id', async () => {
    const res = await request(mountApp()).get('/v1/mail/messages/123');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('MAIL_UPSTREAM_TRANSIENT');
  });

  it('rewrites upstream SESSION_INACTIVE on POST /inbox/:agent/read-all', async () => {
    const res = await request(mountApp()).post('/v1/mail/inbox/DotNetPert-Scout/read-all');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('MAIL_UPSTREAM_TRANSIENT');
  });

  it('passes other upstream 4xx errors through verbatim', async () => {
    upstream = {
      status: 404,
      body: { success: false, error: { code: 'MESSAGE_NOT_FOUND', message: 'No such message' } },
    };
    const res = await request(mountApp()).get('/v1/mail/messages/999');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('MESSAGE_NOT_FOUND');
  });

  it('does not touch successful upstream responses', async () => {
    upstream = { status: 200, body: { success: true, data: { message_id: 555 } } };
    const res = await request(mountApp())
      .post('/v1/mail/send')
      .send({ from_agent: 'DotNetPert-Scout', to: ['NextPert'], subject: 'S', body: 'B' });
    expect(res.status).toBe(200);
    expect(res.body.data.message_id).toBe(555);
  });
});
