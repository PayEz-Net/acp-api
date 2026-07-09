import * as fs from 'fs';
import * as path from 'path';

// Load .env from the acp-api directory into process.env before reading config.
// Electron's spawn of tsx doesn't inherit shell .env, and we don't want secrets
// hardcoded here. Format: KEY=VALUE per line, # for comments. Existing env
// vars take precedence (so production/k8s overrides win).
(function loadDotEnv() {
  // tsx is launched with cwd=acp-api root (see acp-desktop/src/main/api-server.ts),
  // so process.cwd() reliably points at the right place. Using cwd instead of
  // __dirname because this module is ESM and __dirname isn't defined there.
  const envPath = path.join(process.cwd(), '.env');
  try {
    if (!fs.existsSync(envPath)) {
      console.warn(`[config] no .env at ${envPath} — relying entirely on process.env`);
      return;
    }
    const content = fs.readFileSync(envPath, 'utf8');
    let loaded = 0;
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (key && !(key in process.env)) {
        process.env[key] = val;
        loaded++;
      }
    }
    console.log(`[config] loaded ${loaded} env var(s) from ${envPath}`);
  } catch (err: any) {
    console.warn(`[config] failed to load ${envPath}: ${err?.message || err}`);
  }
})();

function required(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`${name} is required but not set — put it in acp-api/.env or export it before launching.`);
  }
  return val;
}

export const config = {
  port: parseInt(process.env.PORT ?? '', 10) || 3001,
  host: '127.0.0.1',
  idpUrl: required('IDP_URL'),
  // De-conflated: acp-api's cloud Vibe API endpoint is its OWN concern,
  // NOT the same as acp-stable's ACP_API_URL (= the local acp-api backend
  // at 127.0.0.1:3001). Reading ACP_API_URL here cross-wired the two: an
  // ACP_API_URL=<prod AKS> meant for nothing leaked in and sent dev-93-
  // minted tokens to prod → 401. Use the dedicated VIBE_API_URL (see
  // .env.example / CLAUDE.md). REQUIRED — no dev-box default in a public build
  // (Decision-C / no-unjustified-fallback; the off-LAN Praveen RCA). The installer
  // injects it (api-server.ts); dev sets it in .env. Do NOT re-merge or re-add a default.
  vibeApiUrl: required('VIBE_API_URL'),
  // Decision-C / durable #104: the vibe_ HMAC client SLUG is MACHINE-AUTH ONLY now.
  // User-session proxies (mail/standup/projects/agents/team) are bearer-only and
  // never touch it. So it is required ONLY when the machine path is active —
  // contractors enabled, or explicit hmac mode. A pure user-session build boots
  // with NO baked Vibe HMAC secret (the public unlock). HMAC stays the machine-
  // auth-only fallback per Bearer-primary policy.
  vibeClientId: (process.env.ENABLE_CONTRACTORS === 'true' || process.env.VIBE_AUTH_MODE === 'hmac')
    ? required('VIBE_CLIENT_ID')
    : (process.env.VIBE_CLIENT_ID || ''),
  // RETIRED 2026-06-11: the bearer X-Client-Id is no longer a baked constant.
  // The old "ACP IS IdealVibe => everyone is tenant 9" assumption broke once
  // beta vibe coders began getting full enterprise setups (own identity + own
  // VibeSQL = their own tenant, e.g. 46). X-Client-Id now mirrors the BEARER'S
  // OWN client_id claim at each call site (auth/tokenManager.requireTokenClientId),
  // so the Vibe admin gate's own-tenant resolution matches. Field deleted to kill
  // the hydra — do NOT reintroduce a constant tenant id here.
  // Required when the machine path is active (contractors sign HMAC unconditionally;
  // hmac mode signs everywhere). User-session bearer build needs none.
  vibeHmacKey: (process.env.VIBE_AUTH_MODE === 'hmac' || process.env.ENABLE_CONTRACTORS === 'true')
    ? required('VIBE_HMAC_KEY')
    : process.env.VIBE_HMAC_KEY,
  acpLocalSecret: process.env.ACP_LOCAL_SECRET || '',
  acpCallbackPort: parseInt(process.env.ACP_CALLBACK_PORT ?? '', 10) || 40030,
  // No hardcoded agent roster. Upstream SignalR subscriptions are driven by
  // the renderer's SSE connection (agents query param), not a baked-in list.
  acpAgents: (process.env.ACP_AGENTS || '').split(',').map(a => a.trim()).filter(Boolean),
  vibeTokenCmd: process.env.VIBE_TOKEN_CMD || './cli.js token',
  vibeTokenRefreshS: parseInt(process.env.VIBE_TOKEN_REFRESH_S ?? '', 10) || 300,
  vibeAuthMode: process.env.VIBE_AUTH_MODE || 'bearer',
  vibeSigningKey: process.env.VIBE_SIGNING_KEY || '',
  execTimeoutMs: parseInt(process.env.EXEC_TIMEOUT_MS ?? '', 10) || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  corsOrigins: process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:40020',
  enableContractors: process.env.ENABLE_CONTRACTORS === 'true', // Disabled by default - not stable yet
  partyTickMs: parseInt(process.env.PARTY_TICK_MS ?? '', 10) || 5000,
  autonomyMaxRuntimeHours: parseInt(process.env.AUTONOMY_MAX_RUNTIME_HOURS ?? '', 10) || 4,
  escalationSensitivity: parseInt(process.env.ESCALATION_SENSITIVITY ?? '', 10) || 2,

  // Deprecated: VibeSQL config - kept for compatibility but not used
  vibesqlUrl: process.env.VIBESQL_URL || '',
  vibesqlDirectUrl: process.env.VIBESQL_DIRECT_URL || '',
  vibesqlContainerSecret: process.env.VIBESQL_CONTAINER_SECRET || '',
};

export type Config = typeof config;
