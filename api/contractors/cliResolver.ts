import { execFileSync } from 'node:child_process';

/**
 * Phase 1 CLI discovery (AC-1, BAPert msg 283). Resolves a contractor CLI
 * binary via the OS PATH lookup: `where` on Windows, `which` on POSIX.
 *
 * - Returns the first resolved absolute path on success.
 * - Returns null when the binary is not on PATH or the lookup fails.
 *
 * Used pre-spawn to fail fast with `onboarding.cli_missing` before any
 * contract/team row is touched. The lookup is synchronous + cheap (no
 * actual process is launched); `execFileSync` + `where/which` returns in
 * microseconds for a hit and single-digit milliseconds for a miss.
 */
export function resolveCliPath(cmd: string): string | null {
  if (!cmd || typeof cmd !== 'string') return null;

  const isWin = process.platform === 'win32';
  const tool = isWin ? 'where' : 'which';

  try {
    const out = execFileSync(tool, [cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      windowsHide: true,
    });
    const first = out.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

/**
 * Install URL lookup for known vendor CLIs. Phase 1 scope per Aurum's call
 * via BAPert msg 290: `claude` is the only first-class vendor. Unknown
 * commands fall back to a generic message — still actionable, just not
 * vendor-branded.
 */
const INSTALL_URLS: Record<string, string> = {
  claude: 'https://docs.anthropic.com/en/docs/claude-code',
  kimi: 'https://platform.moonshot.ai/docs/cli',
  codex: 'https://platform.openai.com/docs/codex',
};

export function installUrlForCmd(cmd: string): string {
  const key = (cmd || '').toLowerCase().split(/[\\\/]/).pop() || '';
  return INSTALL_URLS[key] || 'https://docs.anthropic.com/en/docs/claude-code';
}

export interface CliMissingDetails {
  expected_cmd: string;
  install_url: string;
}

/**
 * Convenience: build the standard `onboarding.cli_missing` error envelope
 * the hire route and teams.spawnHelloWorld return when PATH lookup fails.
 */
export function cliMissingEnvelope(cmd: string) {
  return {
    ok: false as const,
    code: 'onboarding.cli_missing' as const,
    message_key: 'onboarding.cli_missing' as const,
    details: {
      expected_cmd: cmd,
      install_url: installUrlForCmd(cmd),
    } satisfies CliMissingDetails,
  };
}
