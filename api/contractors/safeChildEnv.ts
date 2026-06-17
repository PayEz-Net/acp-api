/**
 * Phase 1 subprocess env narrowing (AC-2, BAPert msg 283 / QAPert audit).
 *
 * Stops acp-api's internal secrets from being inherited into the user's
 * provider CLI. A CLI invoked with `--verbose` or a crash-dump path that
 * echoes `process.env` would otherwise leak ACP_LOCAL_SECRET,
 * VIBESQL_CONTAINER_SECRET, VAULT_API_TOKEN, etc. to the user's
 * stdout/stderr surface.
 *
 * Policy: allowlist, not denylist. If a vendor CLI genuinely needs a
 * system env var we overlooked, the allowlist is easier to extend than a
 * leak is to patch.
 */

/**
 * Env keys the vendor CLI needs to run. Anything not in this list (and
 * not matching a VENDOR_PREFIXES entry) is stripped.
 */
export const DEFAULT_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  // PATH is required for the CLI to resolve its own sub-binaries (e.g.
  // claude shelling out to git or a helper). HOME / USERPROFILE is where
  // every vendor stores its credential cache.
  'PATH',
  'Path', // Windows preserves case; some processes look up the literal 'Path'
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  // Temp dirs — vendor CLIs write short-lived state here.
  'TMPDIR',
  'TEMP',
  'TMP',
  // Locale — needed for correct text rendering on non-en systems.
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  // Windows essentials for most CLIs (codepage, system dirs).
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMDATA',
  'PUBLIC',
  // Terminal hints that don't carry secrets.
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
]);

/**
 * Vendor-prefixed env var namespaces to pass through. The user may have
 * configured `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / etc. in their
 * shell; the vendor CLI's job is to read them. We pass through but do not
 * inject.
 */
export const VENDOR_PREFIXES: ReadonlyArray<string> = [
  'ANTHROPIC_',
  'OPENAI_',
  'MOONSHOT_',
  'CLAUDE_', // older Claude CLI env vars
];

export interface SafeChildEnvOptions {
  /** Override the default allowlist (union, not replace). */
  extraAllow?: ReadonlyArray<string>;
  /** Override the vendor prefix list (union, not replace). */
  extraPrefixes?: ReadonlyArray<string>;
  /** Source env map — defaults to process.env. Exposed for testability. */
  source?: NodeJS.ProcessEnv;
}

/**
 * Build a narrowed env object safe to pass to `spawn(cmd, args, { env })`.
 * The returned map contains:
 *   1. Entries from `source` whose keys are in the allowlist (exact match)
 *   2. Entries from `source` whose keys start with a vendor prefix
 *   3. Everything in `inject` (takes precedence — this is where we pass
 *      ACP_CONVERSATION_ID to the child)
 *
 * Nothing else crosses the boundary. Values are always strings (or
 * undefined, filtered out).
 */
export function safeChildEnv(
  inject: Record<string, string> = {},
  opts: SafeChildEnvOptions = {}
): NodeJS.ProcessEnv {
  const src = opts.source ?? process.env;
  const allow = opts.extraAllow
    ? new Set<string>([...DEFAULT_ENV_ALLOWLIST, ...opts.extraAllow])
    : DEFAULT_ENV_ALLOWLIST;
  const prefixes = opts.extraPrefixes
    ? [...VENDOR_PREFIXES, ...opts.extraPrefixes]
    : VENDOR_PREFIXES;

  const out: NodeJS.ProcessEnv = {};

  for (const [key, val] of Object.entries(src)) {
    if (typeof val !== 'string') continue;
    if (allow.has(key) || prefixes.some(p => key.startsWith(p))) {
      out[key] = val;
    }
  }

  for (const [key, val] of Object.entries(inject)) {
    out[key] = val;
  }

  return out;
}
