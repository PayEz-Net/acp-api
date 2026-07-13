/**
 * Token Manager for ACP API
 *
 * Manages Bearer tokens for Vibe API calls.
 * Tokens are stored in memory (single user desktop app).
 *
 * expiresAt is derived from the JWT's own `exp` claim — not from an
 * `expires_in` field in the wrapping response — because the External ID API
 * login payload doesn't include expires_in, and the IDP session can be
 * shorter than any default we'd invent. Trusting the JWT is the only way
 * ensureValidToken() can actually trigger a refresh before upstream rejects.
 */

import { authRc } from './authRcLog.js';

interface TokenSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  userId: string;
  email: string;
}

let currentSession: TokenSession | null = null;

// Single-flight guard for refreshToken. The IDP issues single-use refresh
// tokens, so parallel refresh calls guarantee failure: the first rotates
// the token, the rest send the now-invalid original and get back
// INVALID_REFRESH_TOKEN. When multiple callers (SSE streams, mail proxy
// retries) need a refresh simultaneously, they must all await the same
// in-flight promise and share its result.
let inflightRefresh: Promise<boolean> | null = null;

// ---- WO-1 Deliverable A: terminal-dead state -------------------------------
// The IDP issues single-use refresh tokens. On an explicit non-retryable
// rejection (INVALID_REFRESH_TOKEN / retryable:false) the session is DEAD —
// retrying only feeds the 401-storm. We latch a MODULE-LEVEL terminal flag
// (must survive currentSession being cleared), short-circuit every refresh
// path to ZERO IDP calls, and fire AUTH_SESSION_DEAD exactly once.
let sessionTerminallyDead = false;
let terminalReason: { code: string; message: string; ts: string } | null = null;

// Secondary anti-storm net ONLY (spec §2.4): bounded CONSECUTIVE ambiguous
// failures (network / 5xx / unparseable). A transient blip must NOT kill a
// live session (counter resets on any success), but an unbounded ambiguous
// loop must still be capped. PRIMARY trigger is always the explicit
// retryable:false signal below — this is just the backstop.
let consecutiveAmbiguousFailures = 0;
const MAX_REFRESH_FAILURES = 8;

function newCid(): string {
  return 'rc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// sidecar→renderer one-shot emitter (AUTH_SESSION_DEAD). Injected by
// server.js so tokenManager stays pure / free of an SSE/express import
// (no circular dep; unit-testable in isolation).
type TerminalDeadEmitter = (reason: { code: string; message: string; ts: string }) => void;
let terminalDeadEmitter: TerminalDeadEmitter | null = null;
export function setTerminalDeadEmitter(fn: TerminalDeadEmitter | null): void {
  terminalDeadEmitter = fn;
}

/**
 * Detect the IDP's terminal (non-retryable) refresh rejection.
 *
 * CRITICAL (live repro 0HNLL0I52K5RP): the IDP DOUBLE-WRAPS. The outer body
 * is JSON with error.code = "UNAUTHORIZED" (HTTP 401). The REAL signal is a
 * .NET `ToString()`-style stringified object embedded INSIDE error.message:
 *   { success = False, error = { code = INVALID_REFRESH_TOKEN ...
 *     retryable = False ... } }
 * Note `=` and spaces, NOT JSON `:`/quotes. So we SCAN THE RAW TEXT — we do
 * NOT assume a parseable nested JSON object. Tolerant of `=` or `:`,
 * optional quotes, and spacing. Exported for the verbatim-payload unit test.
 */
export function parseIdpTerminalSignal(rawBody: string): {
  terminal: boolean;
  code: string | null;
  message: string;
} {
  const body = typeof rawBody === 'string' ? rawBody : '';
  const hasInvalidRefresh = /INVALID_REFRESH_TOKEN/i.test(body);
  // matches:  retryable = False  |  "retryable":false  |  retryable: false
  const nonRetryable = /retryable\s*[:=]\s*"?false"?/i.test(body);
  const terminal = hasInvalidRefresh || nonRetryable;
  let code: string | null = null;
  if (hasInvalidRefresh) {
    code = 'INVALID_REFRESH_TOKEN';
  } else {
    const m = body.match(/code\s*[:=]\s*"?([A-Z][A-Z0-9_]{2,})"?/);
    if (m) code = m[1];
  }
  return { terminal, code, message: body.slice(0, 300) };
}

/** Latch terminal-dead, clear the session, fire AUTH_SESSION_DEAD ONCE. */
function markTerminallyDead(code: string, message: string, cid: string, trigger?: string): void {
  if (sessionTerminallyDead) return; // idempotent — emit exactly once
  sessionTerminallyDead = true;
  terminalReason = { code, message, ts: new Date().toISOString() };
  clearSession();
  authRc({
    phase: 'outcome',
    cid,
    trigger,
    detail: {
      result: 'terminal-dead',
      code,
      idp_message: message,
      clearSession: true,
      auth_session_dead_fired: true,
    },
  });
  try {
    terminalDeadEmitter?.({ ...terminalReason });
  } catch {
    /* a broken emitter must NEVER break the auth path */
  }
}

export function isSessionTerminallyDead(): boolean {
  return sessionTerminallyDead;
}
export function getTerminalReason(): { code: string; message: string; ts: string } | null {
  return terminalReason;
}

function decodeJwtExp(token: string): Date | null {
  const payload = decodeJwtPayload(token);
  if (payload && typeof payload.exp === 'number') {
    return new Date(payload.exp * 1000);
  }
  return null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Resolve the tenant `X-Client-Id` to send upstream FROM THE BEARER ITSELF.
 *
 * Decision-C is "the validated IDP Bearer's client_id claim governs the tenant"
 * — so the X-Client-Id header MUST mirror the token's own `client_id`, not a
 * build-time constant. The old hardcoded `vibeIdealVibeClientNum: 9` forced
 * EVERY request onto the idealvibe tenant (IDP client 9); a user whose token is
 * signed for a different client (e.g. the vibe-agents beta client 46) then fails
 * the Vibe admin gate's own-tenant resolution — VibeJwtMiddleware's §4
 * claim-first bypass requires `X-Client-Id == signed client_id`, so a mismatch
 * drops them to the site-admin gate of a tenant they aren't admin of → 401
 * NO_ADMIN_ACCESS. Mirroring the claim makes the bypass fire off the token's
 * own tenant-admin roles, no per-user is_site_admin grant required.
 *
 * NO FALLBACK: a token with no `client_id` claim is malformed — we throw rather
 * than silently substituting a wrong tenant (a default-to-9 here is exactly the
 * bug this replaces). Callers surface it as an upstream/proxy error.
 */
export function requireTokenClientId(token: string): string {
  const parts = token.split('.');
  if (parts.length === 3) {
    try {
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
      const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
      const cid = payload?.client_id;
      if (cid !== undefined && cid !== null && String(cid).trim() !== '') {
        return String(cid);
      }
    } catch {
      /* fall through to the explicit throw below */
    }
  }
  throw new Error('Bearer token missing client_id claim — cannot resolve tenant for X-Client-Id');
}

// The IDP mints refresh tokens bound to the login-time context, carried in a
// `binding_data` claim shaped: v1|<ip>|<device>|<user-agent>|<client>. On
// refresh the IDP recomputes the binding from the REQUEST's UA / device /
// forwarded-IP and strict-compares. The renderer's OAuth call carried these
// implicitly (browser context); the bare node-side refresh call carries none
// -> "Invalid token binding" / INVALID_REFRESH_TOKEN. Replay exactly what the
// token was minted with, read from the token itself (no guessing, version-
// proof). Any parse failure -> {} so refresh proceeds unchanged (guard, not
// a value default).
function bindingHeadersFromRefreshToken(token: string): Record<string, string> {
  const parts = token.split('.');
  if (parts.length !== 3) return {};
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    const bd: unknown = payload?.binding_data;
    if (typeof bd !== 'string' || !bd.includes('|')) return {};
    const f = bd.split('|');
    // v1 | ip | device | user-agent (kept as the slice in case it has '|') | client
    const ip = f[1];
    const device = f[2];
    const ua = f.slice(3, f.length - 1).join('|');
    const h: Record<string, string> = {};
    if (ua) h['User-Agent'] = ua;
    if (device) h['X-Device-Id'] = device;
    if (ip) h['X-Forwarded-For'] = ip;
    return h;
  } catch {
    return {};
  }
}

export function setSession(session: TokenSession): void {
  // [A §2.5] A freshly-pushed session (fresh login / external-session
  // re-seed) RESETS terminal-dead — post-re-login must work WITHOUT a
  // sidecar restart. Both /v1/auth/login and /v1/auth/external-session
  // funnel through here, so this is the single correct reset point.
  if (sessionTerminallyDead || consecutiveAmbiguousFailures > 0) {
    authRc({
      phase: 'reset',
      detail: {
        was_terminal: sessionTerminallyDead,
        prior_code: terminalReason?.code ?? null,
        cleared_ambiguous: consecutiveAmbiguousFailures,
      },
    });
  }
  sessionTerminallyDead = false;
  terminalReason = null;
  consecutiveAmbiguousFailures = 0;

  // If the caller passed an access token, prefer the JWT's own exp claim.
  const jwtExp = decodeJwtExp(session.accessToken);
  const jwtPayload = decodeJwtPayload(session.accessToken);
  console.log(
    '[TokenManager] Session set — user_id:', session.userId,
    'email:', session.email,
    'client_id:', jwtPayload?.client_id ?? '(missing)',
    'exp:', jwtExp?.toISOString() ?? '(missing)'
  );
  currentSession = {
    ...session,
    expiresAt: jwtExp ?? session.expiresAt,
  };
}

export function getSession(): TokenSession | null {
  return currentSession;
}

export function clearSession(): void {
  currentSession = null;
}

export function getAccessToken(): string | null {
  return currentSession?.accessToken || null;
}

export function isTokenValid(): boolean {
  if (!currentSession) return false;
  // Refresh if token expires in the next 60 seconds.
  const soon = new Date(Date.now() + 60 * 1000);
  return currentSession.expiresAt > soon;
}

export async function refreshToken(idpUrl: string, trigger: string = 'unspecified'): Promise<boolean> {
  // [A §2.3] SHORT-CIRCUIT — a terminally-dead session makes ZERO IDP
  // calls. This is the stop-the-bleed guard: it runs BEFORE the in-flight
  // check so a dead session never even joins a refresh.
  if (sessionTerminallyDead) {
    authRc({
      phase: 'short-circuit',
      trigger,
      detail: { result: 'short-circuited', code: terminalReason?.code ?? null, reason: 'session already terminal — no IDP call' },
    });
    return false;
  }

  // Single-flight (UNCHANGED — guardrail §0): concurrent callers share one
  // upstream round-trip. Sequential re-attempts are NOT covered here — that
  // is exactly the storm the terminal-dead latch above halts.
  if (inflightRefresh) {
    authRc({ phase: 'dedup', trigger, detail: { dedup: 'awaiting in-flight' } });
    return inflightRefresh;
  }

  if (!currentSession?.refreshToken) {
    console.warn('[Auth] refresh skipped: no refresh token in session');
    authRc({ phase: 'outcome', trigger, detail: { result: 'failed', code: 'NO_REFRESH_TOKEN', transient: false } });
    return false;
  }

  const cid = newCid();
  const exp = currentSession.expiresAt;
  authRc({ phase: 'attempt', cid, trigger, detail: {} });
  authRc({
    phase: 'token-state',
    cid,
    trigger,
    detail: {
      // redacted by construction: ISO exp + seconds + booleans only
      access_exp: exp ? exp.toISOString() : null,
      sec_to_expiry: exp ? Math.round((exp.getTime() - Date.now()) / 1000) : null,
      has_refresh_token: !!currentSession.refreshToken,
    },
  });

  inflightRefresh = (async (): Promise<boolean> => {
    // Re-read currentSession inside the promise — by the time we actually
    // run, another caller might have already populated inflightRefresh and
    // we'd double-check, but the outer guard above makes that unreachable.
    const refreshTokenValue = currentSession!.refreshToken!;
    const preflightRefreshToken = refreshTokenValue;

    try {
      // Replay the EXACT binding context the refresh token was minted with
      // (same stuff the OAuth login presented; the server recomputes binding
      // from these). Without it the IDP sees a different fingerprint -> reject.
      const bindingHeaders = bindingHeadersFromRefreshToken(refreshTokenValue);
      const url = `${idpUrl}/api/ExternalAuth/refresh`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': 'idealvibe_online',
          ...bindingHeaders,
        },
        body: JSON.stringify({ refresh_token: refreshTokenValue }),
      });

      // [D §5.4 / §6.4] Full outbound request line + status — closes the
      // layer-2 black hole AT THE SIDECAR END. Binding header PRESENCE only
      // (values redacted).
      authRc({
        phase: 'outbound',
        cid,
        trigger,
        detail: {
          request: `POST ${url}`,
          status: response.status,
          binding_headers_present: {
            'User-Agent': 'User-Agent' in bindingHeaders,
            'X-Device-Id': 'X-Device-Id' in bindingHeaders,
            'X-Forwarded-For': 'X-Forwarded-For' in bindingHeaders,
          },
        },
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '(unreadable)');
        console.error(`[Auth] refresh failed: IDP returned ${response.status} — ${errBody.slice(0, 500)}`);

        // [A §2.2] PRIMARY trigger: explicit non-retryable IDP signal,
        // scanned out of the double-wrapped .NET ToString() message string.
        const sig = parseIdpTerminalSignal(errBody);
        if (sig.terminal) {
          markTerminallyDead(sig.code ?? 'INVALID_REFRESH_TOKEN', sig.message, cid, trigger);
          return false;
        }

        // [A §2.4] Transient (HTTP error WITHOUT the explicit signal):
        // NOT terminal. Bounded secondary anti-storm net only.
        consecutiveAmbiguousFailures += 1;
        authRc({
          phase: 'outcome',
          cid,
          trigger,
          detail: {
            result: 'failed',
            code: `HTTP_${response.status}`,
            retryable: true,
            transient: true,
            idp_message: errBody.slice(0, 300),
            ambiguous_failures: consecutiveAmbiguousFailures,
          },
        });
        if (consecutiveAmbiguousFailures >= MAX_REFRESH_FAILURES) {
          markTerminallyDead('MAX_REFRESH_FAILURES', `bounded anti-storm net: ${consecutiveAmbiguousFailures} consecutive ambiguous failures`, cid, trigger);
        }
        return false;
      }

      const body = await response.json();
      const payload = body?.data ?? body;
      const accessToken = payload?.access_token;
      if (!accessToken) {
        console.error('[Auth] refresh failed: IDP response had no access_token', { bodyKeys: Object.keys(body || {}), payloadKeys: Object.keys(payload || {}) });
        consecutiveAmbiguousFailures += 1;
        authRc({ phase: 'outcome', cid, trigger, detail: { result: 'failed', code: 'NO_ACCESS_TOKEN', transient: true, ambiguous_failures: consecutiveAmbiguousFailures } });
        if (consecutiveAmbiguousFailures >= MAX_REFRESH_FAILURES) {
          markTerminallyDead('MAX_REFRESH_FAILURES', 'bounded anti-storm net: repeated no-access_token', cid, trigger);
        }
        return false;
      }

      const jwtExp = decodeJwtExp(accessToken);
      // Harden: if the session was re-seeded (e.g. fresh login) while this
      // refresh was in flight, do NOT overwrite the newer session with stale
      // tokens from the old refresh context.
      if (currentSession?.refreshToken === preflightRefreshToken) {
        currentSession = {
          accessToken,
          refreshToken: payload?.refresh_token || currentSession!.refreshToken,
          expiresAt: jwtExp ?? new Date(Date.now() + 15 * 60 * 1000),
          userId: payload?.user?.userId || currentSession!.userId,
          email: payload?.user?.email || currentSession!.email,
        };
      }
      consecutiveAmbiguousFailures = 0; // any success resets the backstop
      const logExp = currentSession?.expiresAt?.toISOString() ?? 'unknown';
      console.log(`[Auth] refresh ok, expires ${logExp}`);
      authRc({ phase: 'outcome', cid, trigger, detail: { result: 'refreshed', new_exp: logExp } });

      return true;
    } catch (err: any) {
      // [A §2.4] Network error / exception = TRANSIENT, never terminal. A
      // blip must not kill a live session.
      console.error(`[Auth] refresh threw: ${err?.message || err}`);
      consecutiveAmbiguousFailures += 1;
      authRc({
        phase: 'outcome',
        cid,
        trigger,
        detail: { result: 'failed', code: 'NETWORK_OR_THROW', transient: true, error: String(err?.message || err).slice(0, 200), ambiguous_failures: consecutiveAmbiguousFailures },
      });
      if (consecutiveAmbiguousFailures >= MAX_REFRESH_FAILURES) {
        markTerminallyDead('MAX_REFRESH_FAILURES', 'bounded anti-storm net: repeated network/throw', cid, trigger);
      }
      return false;
    } finally {
      inflightRefresh = null;
    }
  })();

  return inflightRefresh;
}

export async function ensureValidToken(idpUrl: string, trigger: string = 'unspecified'): Promise<string | null> {
  // [A §2.3] Short-circuit before any session/IDP work.
  if (sessionTerminallyDead) {
    authRc({ phase: 'short-circuit', trigger, detail: { result: 'short-circuited', via: 'ensureValidToken', code: terminalReason?.code ?? null } });
    return null;
  }
  if (!currentSession) return null;

  if (!isTokenValid() && currentSession.refreshToken) {
    const refreshed = await refreshToken(idpUrl, trigger);
    if (!refreshed) return null;
  }

  return currentSession.accessToken;
}

/**
 * Force a refresh regardless of local expiry. Called by mailProxy when the
 * cloud returns 401 despite our local check saying the token is valid —
 * the IDP session may have been invalidated out-of-band.
 */
export async function forceRefresh(idpUrl: string, trigger: string = 'unspecified'): Promise<string | null> {
  // [A §2.3] Short-circuit — without this, mailProxy's forceRefresh-on-401
  // retry (the storm's loudest caller) keeps hammering the IDP.
  if (sessionTerminallyDead) {
    authRc({ phase: 'short-circuit', trigger, detail: { result: 'short-circuited', via: 'forceRefresh', code: terminalReason?.code ?? null } });
    return null;
  }
  if (!currentSession?.refreshToken) return null;
  const ok = await refreshToken(idpUrl, trigger);
  if (!ok) return null;
  return currentSession?.accessToken ?? null;
}
