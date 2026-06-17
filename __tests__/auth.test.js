import { jest } from '@jest/globals';
import {
  setSession,
  clearSession,
  refreshToken,
  ensureValidToken,
  forceRefresh,
  parseIdpTerminalSignal,
  setTerminalDeadEmitter,
  isSessionTerminallyDead,
} from '../api/auth/tokenManager.js';
import { _resetAuthRc, getAuthRc } from '../api/auth/authRcLog.js';

// ── WO-1 §1a — VERBATIM live-repro payload (request_id 0HNLL0I52K5RP,
// captured by Jon 2026-05-19T19:26:28Z). This is acceptance test #1's real
// reproduction. The IDP DOUBLE-WRAPS: outer error.code=UNAUTHORIZED (HTTP
// 401); the real signal is a .NET ToString()-style string inside
// error.message (`=`/spaces, NOT JSON `:`/quotes). DO NOT "tidy" this.
const LIVE_REPRO_401_BODY = JSON.stringify({
  success: false,
  error: {
    code: 'UNAUTHORIZED',
    message:
      '{ success = False, error = { code = INVALID_REFRESH_TOKEN, message = Token refresh failed, discard_token = False, retryable = False, resolution = Authentication failed. Please sign in again. } }',
    support: {
      request_id: '0HNLL0I52K5RP:00000007',
      time_stamp: '2026-05-19T19:26:28.3284829Z',
    },
  },
});

function mockFetchResponse({ ok, status, text }) {
  return {
    ok,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

function seedSession() {
  setSession({
    accessToken: 'header.payload.sig', // not a real JWT — exp decode fails -> fallback
    refreshToken: 'refresh-token-value',
    expiresAt: new Date(Date.now() - 1000), // already expired -> forces refresh
    userId: 'u1',
    email: 'dev@example.com',
  });
}

describe('parseIdpTerminalSignal — double-wrapped .NET ToString() signal (§1a)', () => {
  test('VERBATIM live-repro payload is detected terminal w/ INVALID_REFRESH_TOKEN', () => {
    const sig = parseIdpTerminalSignal(LIVE_REPRO_401_BODY);
    expect(sig.terminal).toBe(true);
    expect(sig.code).toBe('INVALID_REFRESH_TOKEN');
  });

  test('clean nested JSON variant (retryable:false) also terminal', () => {
    const sig = parseIdpTerminalSignal('{"error":{"code":"INVALID_REFRESH_TOKEN","retryable":false}}');
    expect(sig.terminal).toBe(true);
    expect(sig.code).toBe('INVALID_REFRESH_TOKEN');
  });

  test('transient 503 (no signal) is NOT terminal', () => {
    const sig = parseIdpTerminalSignal('{"error":{"code":"UNAVAILABLE","message":"upstream 503"}}');
    expect(sig.terminal).toBe(false);
  });

  test('retryable = True is NOT terminal (a blip must not kill the session)', () => {
    const sig = parseIdpTerminalSignal('{ success = False, error = { code = SOMETHING, retryable = True } }');
    expect(sig.terminal).toBe(false);
  });

  test('unparseable / network garbage is NOT terminal', () => {
    expect(parseIdpTerminalSignal('<html>502 Bad Gateway</html>').terminal).toBe(false);
    expect(parseIdpTerminalSignal('').terminal).toBe(false);
  });
});

describe('terminal-dead + short-circuit (Deliverable A, acceptance §6.1)', () => {
  beforeEach(() => {
    _resetAuthRc();
    clearSession();
    setTerminalDeadEmitter(null);
  });

  test('exactly ONE IDP attempt on INVALID_REFRESH_TOKEN, then ZERO further calls; AUTH_SESSION_DEAD fires ONCE', async () => {
    const fetchMock = jest.fn(async () =>
      mockFetchResponse({ ok: false, status: 401, text: LIVE_REPRO_401_BODY }),
    );
    global.fetch = fetchMock;

    const emitter = jest.fn();
    setTerminalDeadEmitter(emitter);
    seedSession();

    // Attempt #1 — the one and only real IDP call
    const r1 = await refreshToken('https://idp.test', 'test');
    expect(r1).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isSessionTerminallyDead()).toBe(true);
    expect(emitter).toHaveBeenCalledTimes(1);
    expect(emitter.mock.calls[0][0].code).toBe('INVALID_REFRESH_TOKEN');

    // Every subsequent path short-circuits — ZERO further IDP calls
    expect(await refreshToken('https://idp.test', 'test')).toBe(false);
    expect(await ensureValidToken('https://idp.test', 'test')).toBe(null);
    expect(await forceRefresh('https://idp.test', 'test')).toBe(null);
    expect(fetchMock).toHaveBeenCalledTimes(1); // still ONE
    expect(emitter).toHaveBeenCalledTimes(1); // still ONCE (idempotent)

    // [AuthRC] shows the whole sequence compactly (<10 readable lines)
    const rc = getAuthRc(50);
    const terminal = rc.filter((e) => e.detail?.result === 'terminal-dead');
    const shorted = rc.filter((e) => e.phase === 'short-circuit');
    expect(terminal.length).toBe(1);
    // [WO-2A] Identical-code short-circuits now collapse to FIRST + aggregate.
    // The 3 short-circuited calls above (refresh/ensure/force, same code)
    // yield 1 ring short-circuit + 1 failed-aggregate summary. Was `>= 3`
    // (the pre-WO-2A un-aggregated behavior); the test's intent — "short-
    // circuit observable in ring" — is preserved by both assertions.
    expect(shorted.length).toBe(1);
    const scAgg = rc.filter(
      (e) => e.detail?.result === 'failed-aggregate' && e.detail?.phase_source === 'short-circuit',
    );
    expect(scAgg.length).toBe(1);
    expect(scAgg[0].detail.code).toBe('INVALID_REFRESH_TOKEN');
    expect(scAgg[0].detail.repeats).toBe(3);
    expect(rc.length).toBeLessThan(15);
  });

  test('transient 503 does NOT mark terminal (single blip survives)', async () => {
    global.fetch = jest.fn(async () =>
      mockFetchResponse({ ok: false, status: 503, text: '{"error":{"code":"UNAVAILABLE"}}' }),
    );
    seedSession();

    expect(await refreshToken('https://idp.test', 'test')).toBe(false);
    expect(isSessionTerminallyDead()).toBe(false); // still alive — retryable
  });

  test('§2.5 — a fresh setSession() resets terminal-dead (re-login w/o restart)', async () => {
    global.fetch = jest.fn(async () =>
      mockFetchResponse({ ok: false, status: 401, text: LIVE_REPRO_401_BODY }),
    );
    seedSession();
    await refreshToken('https://idp.test', 'test');
    expect(isSessionTerminallyDead()).toBe(true);

    // Re-seed (fresh login / external-session both funnel through setSession)
    setSession({
      accessToken: 'new.jwt.token',
      refreshToken: 'fresh-rt',
      expiresAt: new Date(Date.now() + 3600_000),
      userId: 'u1',
      email: 'dev@example.com',
    });
    expect(isSessionTerminallyDead()).toBe(false);
  });
});

// ── WO-2A — aggregator collapses repeated short-circuits (post-dead storm).
// Acceptance: after latch, ensureValidToken x100 yields ring delta ≤ 2
// (first short-circuit + rolling aggregate) and console split warn=1 +
// error=1 (BAPert Q1 ruling: existing channel split preserved; total
// post-latch emissions = 2, matching WO §ACCEPTANCE intent).
describe('aggregator collapses repeated short-circuits (WO-2A)', () => {
  let warnSpy;
  let errorSpy;

  beforeEach(() => {
    _resetAuthRc();
    clearSession();
    setTerminalDeadEmitter(null);
  });

  afterEach(() => {
    if (warnSpy) warnSpy.mockRestore();
    if (errorSpy) errorSpy.mockRestore();
    warnSpy = undefined;
    errorSpy = undefined;
  });

  test('post-latch: ensureValidToken x100 → ring delta ≤ 2, console warn=1 + error=1', async () => {
    global.fetch = jest.fn(async () =>
      mockFetchResponse({ ok: false, status: 401, text: LIVE_REPRO_401_BODY }),
    );
    seedSession();

    // 1) Engage the latch via the real IDP-call path (one fetch, one terminal-dead outcome).
    expect(await refreshToken('https://idp.test', 'test')).toBe(false);
    expect(isSessionTerminallyDead()).toBe(true);

    // 2) Snapshot ring length pre-storm — we measure the DELTA (the storm's footprint),
    //    not the absolute ring (which still contains attempt/token-state/outbound/terminal-dead).
    const ringBefore = getAuthRc(200).length;

    // 3) Spy on consoles AFTER latch so we count only post-dead emissions.
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    // 4) The storm: 100 identical short-circuited ensureValidToken calls.
    for (let i = 0; i < 100; i++) {
      const t = await ensureValidToken('https://idp.test', 'mail');
      expect(t).toBeNull();
    }

    // 5) Pull (also triggers flushAggregate('read') so the aggregate becomes visible).
    const rcAfter = getAuthRc(200);
    const delta = rcAfter.slice(ringBefore);

    // Ring footprint: exactly the FIRST short-circuit + the rolling aggregate.
    expect(delta.length).toBeLessThanOrEqual(2);

    const firstSc = delta.find((e) => e.phase === 'short-circuit');
    expect(firstSc).toBeDefined();
    expect(firstSc.detail.code).toBe('INVALID_REFRESH_TOKEN');

    const agg = delta.find((e) => e.detail?.result === 'failed-aggregate');
    expect(agg).toBeDefined();
    expect(agg.phase).toBe('outcome'); // back-compat: parsers keying on phase==='outcome' still work
    expect(agg.detail.code).toBe('INVALID_REFRESH_TOKEN');
    expect(agg.detail.phase_source).toBe('short-circuit');
    expect(agg.detail.repeats).toBe(100); // first occurrence + 99 collapsed = 100 total
    expect(agg.detail.note).toMatch(/^short-circuited:INVALID_REFRESH_TOKEN x100 in \d+s$/);

    // Console split per BAPert Q1 ruling:
    //   warn=1 (first short-circuit, via existing line-127 dispatch)
    //   error=1 (aggregate flush, via existing line-79 dispatch)
    // Total post-latch console emissions = 2, satisfying WO §ACCEPTANCE intent
    // ("console.warn called exactly 2 times total") while preserving the
    // existing channel semantics (aggregate flush is error-class).
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
