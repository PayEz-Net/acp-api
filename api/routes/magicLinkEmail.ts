import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';

/**
 * Phase 1 magic-link email forwarder. Narrow hot-patch backfill from
 * acp-stable-api (commits e265ffd + 8dccbbe + f8f0e0b0d on the IDP side)
 * per BAPert msg 343. This file intentionally has no dependency on the
 * /issue / /redeem routes that live in acp-stable-api but not here — the
 * Better Auth plugin inside @payez/next-mvp 4.1.0 generates/stores/redeems
 * the token, so ACP's only responsibility is "POST this email+link at
 * the IDP's /api/ExternalAuth/magic-link/send endpoint and propagate the
 * result."
 *
 * Rate-limited per lowercase email (1/min, 10/hour) — standalone buckets
 * since there's no /issue path to share state with on this repo.
 */

interface RateBucket {
  count: number;
  windowStart: number;
  lastRequest: number;
}

const rateBuckets = new Map<string, RateBucket>();
const RATE_WINDOW_MS = 60 * 1000;
const HOURLY_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_PER_HOUR = 10;
const IDP_TIMEOUT_MS = 10_000;

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

function isValidEmailShape(email: string): boolean {
  return /^.+@.+\..+$/.test(email);
}

function checkRateLimit(emailLower: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  let bucket = rateBuckets.get(emailLower);
  if (!bucket || now - bucket.windowStart > HOURLY_WINDOW_MS) {
    bucket = { count: 0, windowStart: now, lastRequest: 0 };
    rateBuckets.set(emailLower, bucket);
  }
  if (now - bucket.lastRequest < RATE_WINDOW_MS) {
    const retryAfter = Math.ceil((RATE_WINDOW_MS - (now - bucket.lastRequest)) / 1000);
    return { allowed: false, retryAfterSeconds: retryAfter };
  }
  if (bucket.count >= RATE_LIMIT_PER_HOUR) {
    const retryAfter = Math.ceil((HOURLY_WINDOW_MS - (now - bucket.windowStart)) / 1000);
    return { allowed: false, retryAfterSeconds: retryAfter };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

function recordRequest(emailLower: string): void {
  const bucket = rateBuckets.get(emailLower);
  if (bucket) {
    bucket.count++;
    bucket.lastRequest = Date.now();
  }
}

/**
 * Forward a pre-signed magic-link URL to the IDP for rendering + delivery.
 * Reads `parsed.error?.message ?? parsed.message` so both the post-QAPert-fix
 * envelope (`{ error: { message } }`) and any legacy flat `{ message }` shape
 * propagate cleanly. Exported for test access.
 */
export async function postMagicLinkToIdp(
  email: string,
  link: string,
  opts: { idpUrl?: string; fetchImpl?: typeof fetch } = {}
): Promise<{ ok: boolean; error?: string }> {
  const idpUrl = (opts.idpUrl ?? config.idpUrl).replace(/\/$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  const endpoint = `${idpUrl}/api/ExternalAuth/magic-link/send`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IDP_TIMEOUT_MS);
  // Intentionally untyped — TS picks up Express's Response at module scope
  // because of the `Request, Response` import from express; let inference
  // pull the fetch `Response` here instead of colliding on the name.
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, link, expiry_minutes: 15 }),
      signal: controller.signal,
    });
  } catch (err: any) {
    return {
      ok: false,
      error: err?.name === 'AbortError' ? 'idp_timeout' : err?.message || 'idp_fetch_failed',
    };
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    let detail = `idp_status_${res.status}`;
    try {
      const parsed: any = await res.json();
      const msg: string | undefined = parsed?.error?.message ?? parsed?.message;
      if (msg) detail = `idp:${res.status}:${msg}`;
    } catch {
      /* non-JSON — keep status-only detail */
    }
    return { ok: false, error: detail };
  }

  try {
    const parsed = (await res.json()) as { success?: boolean; message?: string };
    if (parsed.success === false) {
      return { ok: false, error: parsed.message || 'idp_send_failed' };
    }
  } catch {
    return { ok: false, error: 'idp_malformed_response' };
  }
  return { ok: true };
}

export default function magicLinkEmailRoutes(): Router {
  const router = Router();

  // POST /v1/auth/magic-link/email
  router.post('/email', async (req: Request, res: Response) => {
    const requestId = (req as any).requestId || randomUUID();
    res.setHeader('X-Request-Id', requestId);

    const { email, link } = req.body || {};

    if (!email || typeof email !== 'string' || !isValidEmailShape(email)) {
      res.status(400).json({
        ok: false,
        code: 'magic_link.bad_request',
        message_key: 'magic_link.bad_request',
        details: { field: 'email' },
      });
      return;
    }

    if (!link || typeof link !== 'string' || !/^https?:\/\//i.test(link)) {
      res.status(400).json({
        ok: false,
        code: 'magic_link.bad_request',
        message_key: 'magic_link.bad_request',
        details: { field: 'link' },
      });
      return;
    }

    const emailLower = normalizeEmail(email);
    const rateCheck = checkRateLimit(emailLower);
    if (!rateCheck.allowed) {
      res.setHeader('Retry-After', String(rateCheck.retryAfterSeconds));
      res.status(429).json({
        ok: false,
        code: 'magic_link.rate_limited',
        message_key: 'magic_link.rate_limited',
        details: { retry_after_seconds: rateCheck.retryAfterSeconds },
      });
      return;
    }
    recordRequest(emailLower);

    const result = await postMagicLinkToIdp(emailLower, link);
    if (!result.ok) {
      res.status(500).json({
        ok: false,
        code: 'magic_link.provider_error',
        message_key: 'magic_link.provider_error',
        details: { error: result.error },
      });
      return;
    }

    res.status(202).json({
      ok: true,
      code: 'magic_link.email_queued',
      message_key: 'magic_link.email_queued',
    });
  });

  return router;
}

/** Test-only hook to clear the rate-limit buckets. */
export function _clearMagicLinkEmailStoresForTesting(): void {
  rateBuckets.clear();
}
