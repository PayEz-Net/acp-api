/**
 * Phase 1 CLI output scrubber (AC-2, BAPert msg 283, QAPert #10508).
 *
 * Applied in ProcessMonitor.appendOutput and TerminalOutputBridge before the
 * captured text reaches SSE or the `agent_output_events` table. Redacts:
 *
 *   1. EXACT-MATCH secret values: ACP-injected env var values (e.g.
 *      ACP_LOCAL_SECRET) that a `--verbose` vendor CLI might echo back.
 *   2. Provider API keys and 32+ character token-like strings adjacent to
 *      key, token, secret, api, or sk-.
 *   3. .env-style secret assignments.
 *   4. USER HOME PATH: replaced with `<home>` preserving trailing path
 *      segments, across Windows and POSIX layouts.
 *
 * NOT a general-purpose PII redactor. Scope is limited to the Phase 1
 * audit surface. Vendor-specific PII in CLI output is out of scope; the
 * CLI is the authority and we do not parse its semantics.
 */

/**
 * Env keys whose VALUES get redacted from subprocess output. These are
 * ACP-internal secrets — a vendor CLI should never see them, but if it
 * does and echoes them, the scrubber is the last line of defense.
 */
export const DEFAULT_SECRET_ENV_KEYS: ReadonlyArray<string> = [
  'ACP_LOCAL_SECRET',
  'ACP_CONVERSATION_ID',
  'VIBESQL_CONTAINER_SECRET',
  'VAULT_API_TOKEN',
  'VIBE_HMAC_KEY',
  'VIBE_SIGNING_KEY',
];

/**
 * Minimum length for an env value to be considered worth redacting. Short
 * values (like an all-uppercase flag `"true"`) would cause overaggressive
 * replacement across unrelated output.
 */
const MIN_SECRET_LENGTH = 8;

/** Minimum length for a token-like value to be treated as a secret. */
const MIN_TOKEN_LENGTH = 32;

export interface ScrubContext {
  /** Literal strings to replace with `<acp-env>` wherever they appear. */
  secretValues: ReadonlyArray<string>;
  /** Home-dir prefixes to replace with `<home>`. Both separator styles. */
  homeDirs: ReadonlyArray<string>;
}

/**
 * Build a default scrub context from the current process env. Captures
 * at call time; values that change later in the process lifetime won't
 * retroactively scrub earlier output — that's fine for subprocess output
 * since the child already inherited a snapshot of env at spawn.
 */
export function buildDefaultScrubContext(env: NodeJS.ProcessEnv = process.env): ScrubContext {
  const secretValues: string[] = [];
  for (const key of DEFAULT_SECRET_ENV_KEYS) {
    const v = env[key];
    if (typeof v === 'string' && v.length >= MIN_SECRET_LENGTH) {
      secretValues.push(v);
    }
  }

  const homeDirs: string[] = [];
  const homeSources = [env.USERPROFILE, env.HOME];
  for (const h of homeSources) {
    if (typeof h === 'string' && h.length > 3) {
      homeDirs.push(h);
      // Forward-slash variant that Node's `path.posix` / many tools emit
      if (h.includes('\\')) homeDirs.push(h.replace(/\\/g, '/'));
    }
  }

  return { secretValues, homeDirs };
}

/** RegExp special-char escape for building dynamic regexes from literals. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scrub a chunk of subprocess output. Pure function — does not read env
 * on its own; caller provides the context (testable).
 */
export function scrubOutput(text: string, ctx: ScrubContext): string {
  if (!text) return text;
  let out = text;

  // Pass 1: exact-match secret values. Order matters — redact longest
  // first so a short prefix doesn't cut a longer secret in half.
  const sortedSecrets = [...ctx.secretValues]
    .filter(v => v.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  for (const v of sortedSecrets) {
    out = out.split(v).join('<acp-env>');
  }

  // Pass 2: provider API keys and generic token-like strings adjacent to
  // key, token, secret, api, or sk- (QAPert #10508).
  // Examples: api_key=abc123..., token: "...", SECRET=...
  // Capture group 1 is the keyword so it survives redaction.
  const tokenLikeRe = new RegExp(
    '\\b((?:api[_-]?key|api[_-]?token|apikey|apitoken|token|secret|key|sk))\\s*[:=]\\s*["\']?([A-Za-z0-9_\\-./+=]{' + MIN_TOKEN_LENGTH + ',})',
    'gi',
  );
  out = out.replace(tokenLikeRe, '$1=<secret>');

  // Pass 2b: OpenAI/Codex-style `sk-...` keys that may appear standalone.
  out = out.replace(/\bsk-[a-zA-Z0-9_-]{32,}\b/gi, '<secret>');

  // Pass 3: .env-style secret assignments (KEY=VALUE) where the key looks
  // like a secret carrier and the value is non-trivial but NOT long enough
  // to be caught by the token-like pass. Redacts the value but keeps the
  // key/export keyword.
  out = out.replace(
    /^\s*(export\s+)?([A-Z_]*(?:SECRET|TOKEN|KEY|API|PASSWORD)[A-Z_]*)\s*=\s*(?!<env>|<secret>|<acp-env>)(\S{4,31})\s*$/gim,
    '$1$2=<env>',
  );

  // Pass 4: case-insensitive user home prefix. We replace only the
  // user-specific part (drive + Users + <name>) and preserve the rest of
  // the path so downstream consumers can still reference file locations.
  const isWin = process.platform === 'win32';
  for (const home of ctx.homeDirs) {
    if (home.length === 0) continue;
    const flags = isWin ? 'gi' : 'g';
    const re = new RegExp(escapeRegex(home), flags);
    out = out.replace(re, '<home>');
  }

  // Pass 5: generic Windows home patterns we may not have captured from
  // env (e.g. paths in subprocess output referring to the default profile
  // under a different drive, 8.3 short-path forms, mixed case).
  //   C:\Users\<name>  or  D:\Users\<name>  (backslash)
  //   C:/Users/<name>  etc.                  (forward slash)
  //   c:\users\jon-lo~1                       (8.3 short-path / lower case)
  out = out.replace(/[A-Za-z]:\\Users\\[^\\\/\r\n\s"'`]+/gi, '<home>');
  out = out.replace(/[A-Za-z]:\/Users\/[^\\\/\r\n\s"'`]+/gi, '<home>');

  // Pass 6: POSIX home patterns.
  //   /home/<name>/...    (Linux)
  //   /Users/<name>/...   (macOS)
  out = out.replace(/\/home\/[^\/\r\n\s"'`]+/g, '<home>');
  out = out.replace(/\/Users\/[^\/\r\n\s"'`]+/g, '<home>');

  return out;
}
