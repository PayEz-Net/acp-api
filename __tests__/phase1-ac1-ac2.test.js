import { jest } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveStubPath } from './fixtures/stub-cli/helper.js';

let resolveCliPath, installUrlForCmd, cliMissingEnvelope;
let safeChildEnv, DEFAULT_ENV_ALLOWLIST, VENDOR_PREFIXES;
let scrubOutput, buildDefaultScrubContext, DEFAULT_SECRET_ENV_KEYS;

beforeAll(async () => {
  const cliMod = await import('../api/contractors/cliResolver.js');
  resolveCliPath = cliMod.resolveCliPath;
  installUrlForCmd = cliMod.installUrlForCmd;
  cliMissingEnvelope = cliMod.cliMissingEnvelope;

  const envMod = await import('../api/contractors/safeChildEnv.js');
  safeChildEnv = envMod.safeChildEnv;
  DEFAULT_ENV_ALLOWLIST = envMod.DEFAULT_ENV_ALLOWLIST;
  VENDOR_PREFIXES = envMod.VENDOR_PREFIXES;

  const scrubMod = await import('../api/contractors/outputScrubber.js');
  scrubOutput = scrubMod.scrubOutput;
  buildDefaultScrubContext = scrubMod.buildDefaultScrubContext;
  DEFAULT_SECRET_ENV_KEYS = scrubMod.DEFAULT_SECRET_ENV_KEYS;
});

// ------------------------------------------------------------------
// AC-1  CLI discovery
// ------------------------------------------------------------------

describe('resolveCliPath', () => {
  test('returns null for non-existent binary', () => {
    expect(resolveCliPath('definitely_not_on_path_xyz_12345')).toBeNull();
  });

  test('returns null for empty/non-string', () => {
    expect(resolveCliPath('')).toBeNull();
    expect(resolveCliPath(null)).toBeNull();
    expect(resolveCliPath(undefined)).toBeNull();
    expect(resolveCliPath(42)).toBeNull();
  });

  test('resolves known system binary', () => {
    const found = resolveCliPath(process.platform === 'win32' ? 'cmd' : 'sh');
    expect(found).toBeTruthy();
    expect(typeof found).toBe('string');
  });
});

describe('installUrlForCmd', () => {
  test('returns Claude docs for "claude"', () => {
    expect(installUrlForCmd('claude')).toContain('claude');
    expect(installUrlForCmd('claude')).toMatch(/^https?:\/\//);
  });

  test('handles absolute path forms', () => {
    expect(installUrlForCmd('/usr/local/bin/kimi')).toMatch(/^https?:\/\//);
  });

  test('falls back for unknown', () => {
    expect(installUrlForCmd('unknown-xyz')).toMatch(/^https?:\/\//);
  });
});

describe('cliMissingEnvelope', () => {
  test('has audit-specified shape', () => {
    const env = cliMissingEnvelope('kimi');
    expect(env.ok).toBe(false);
    expect(env.code).toBe('onboarding.cli_missing');
    expect(env.message_key).toBe('onboarding.cli_missing');
    expect(env.details).toHaveProperty('expected_cmd', 'kimi');
    expect(env.details).toHaveProperty('install_url');
  });
});

// ------------------------------------------------------------------
// AC-2  safeChildEnv
// ------------------------------------------------------------------

describe('safeChildEnv', () => {
  test('strips ACP_LOCAL_SECRET etc.', () => {
    const out = safeChildEnv({}, {
      source: {
        PATH: '/usr/bin',
        ACP_LOCAL_SECRET: 'shh',
        VIBESQL_CONTAINER_SECRET: 'also-shh',
      },
    });
    expect(out.PATH).toBe('/usr/bin');
    expect(out.ACP_LOCAL_SECRET).toBeUndefined();
    expect(out.VIBESQL_CONTAINER_SECRET).toBeUndefined();
  });

  test('strips arbitrary non-allowlisted', () => {
    const out = safeChildEnv({}, {
      source: { PATH: '/bin', MY_RANDOM_VAR: 'x' },
    });
    expect(out.MY_RANDOM_VAR).toBeUndefined();
  });

  test('passes through vendor-prefixed', () => {
    const out = safeChildEnv({}, {
      source: {
        PATH: '/bin',
        ANTHROPIC_API_KEY: 'ak',
        OPENAI_API_KEY: 'ok',
        CLAUDE_CODE_DEBUG: '1',
        MOONSHOT_API_KEY: 'mk',
      },
    });
    expect(out.ANTHROPIC_API_KEY).toBe('ak');
    expect(out.OPENAI_API_KEY).toBe('ok');
    expect(out.CLAUDE_CODE_DEBUG).toBe('1');
    expect(out.MOONSHOT_API_KEY).toBe('mk');
  });

  test('inject overrides source', () => {
    const out = safeChildEnv({ PATH: '/override' }, { source: { PATH: '/original' } });
    expect(out.PATH).toBe('/override');
  });

  test('always includes injected keys', () => {
    const out = safeChildEnv({ FOO: 'bar' }, { source: { PATH: '/bin' } });
    expect(out.FOO).toBe('bar');
  });

  test('allowlist and prefix lists exposed', () => {
    expect(DEFAULT_ENV_ALLOWLIST.size).toBeGreaterThan(10);
    expect(VENDOR_PREFIXES.length).toBeGreaterThanOrEqual(1);
  });
});

// ------------------------------------------------------------------
// AC-2  outputScrubber
// ------------------------------------------------------------------

describe('scrubOutput', () => {
  test('redacts exact secret values', () => {
    const text = 'token=super-secret-value is here';
    const out = scrubOutput(text, { secretValues: ['super-secret-value'], homeDirs: [] });
    expect(out).toBe('token=<acp-env> is here');
  });

  test('redacts multiple occurrences', () => {
    const text = 'a super-secret-value b super-secret-value c';
    const out = scrubOutput(text, { secretValues: ['super-secret-value'], homeDirs: [] });
    expect(out).toBe('a <acp-env> b <acp-env> c');
  });

  test('does not touch short values', () => {
    const text = 'short';
    const out = scrubOutput(text, { secretValues: ['short'], homeDirs: [] });
    // MIN_SECRET_LENGTH is 8, so 'short' is ignored
    expect(out).toBe('short');
  });

  test('redacts backslash Windows home', () => {
    const text = 'C:\\Users\\Alice\\project';
    const out = scrubOutput(text, { secretValues: [], homeDirs: ['C:\\Users\\Alice'] });
    expect(out).toContain('<home>');
    expect(out).not.toContain('\\Users\\Alice');
  });

  test('redacts forward-slash Windows home', () => {
    const text = 'C:/Users/Bob/project';
    const out = scrubOutput(text, { secretValues: [], homeDirs: ['C:/Users/Bob'] });
    expect(out).toContain('<home>');
    expect(out).not.toContain('/Users/Bob');
  });

  test('redacts POSIX forms via generic pass', () => {
    const text = '/home/charlie/.ssh/id_rsa';
    const out = scrubOutput(text, { secretValues: [], homeDirs: [] });
    expect(out).toContain('<home>');
    expect(out).not.toContain('/home/charlie');
  });

  test('redacts lowercase/8.3 forms', () => {
    const text = 'c:\\users\\Dave\\file.txt';
    const out = scrubOutput(text, { secretValues: [], homeDirs: [] });
    expect(out).toContain('<home>');
    expect(out).not.toContain('\\users\\Dave');
  });

  test('preserves path suffix', () => {
    const text = '/home/eve/.acp/settings.json';
    const out = scrubOutput(text, { secretValues: [], homeDirs: [] });
    expect(out).toContain('/settings.json');
  });

  test('returns empty input unchanged', () => {
    expect(scrubOutput('', { secretValues: [], homeDirs: [] })).toBe('');
    expect(scrubOutput(null, { secretValues: [], homeDirs: [] })).toBe(null);
    expect(scrubOutput(undefined, { secretValues: [], homeDirs: [] })).toBe(undefined);
  });
});

describe('buildDefaultScrubContext', () => {
  test('populates secretValues from env', () => {
    const ctx = buildDefaultScrubContext({ ACP_LOCAL_SECRET: 'a-long-secret-here' });
    expect(ctx.secretValues).toContain('a-long-secret-here');
  });

  test('populates homeDirs from USERPROFILE', () => {
    const ctx = buildDefaultScrubContext({ USERPROFILE: 'C:\\Users\\Test' });
    expect(ctx.homeDirs.some(h => h.includes('Users'))).toBe(true);
  });

  test('DEFAULT_SECRET_ENV_KEYS stable list', () => {
    expect(DEFAULT_SECRET_ENV_KEYS).toContain('ACP_LOCAL_SECRET');
    expect(DEFAULT_SECRET_ENV_KEYS).toContain('VIBESQL_CONTAINER_SECRET');
    expect(DEFAULT_SECRET_ENV_KEYS).toContain('VAULT_API_TOKEN');
  });
});

// ------------------------------------------------------------------
// QAPert fixture integration
// ------------------------------------------------------------------

describe('QAPert fixture integration', () => {
  test('resolveStubPath returns platform paths', () => {
    const stub = resolveStubPath('env-dumper');
    expect(stub).toContain('env-dumper');
    if (process.platform === 'win32') {
      expect(stub).toContain('.cmd');
    } else {
      expect(stub).toContain('.sh');
    }
  });

  test('safeChildEnv + env-dumper static check', () => {
    const childEnv = safeChildEnv({ ACP_CONVERSATION_ID: 'conv-123' }, {
      source: {
        PATH: process.env.PATH || '',
        ACP_LOCAL_SECRET: 'shh-secret-here',
        MY_RANDOM_VAR: 'should-not-appear',
      },
      extraAllow: [],
      extraPrefixes: [],
    });

    expect(childEnv.ACP_CONVERSATION_ID).toBe('conv-123');
    expect(childEnv.ACP_LOCAL_SECRET).toBeUndefined();
    expect(childEnv.MY_RANDOM_VAR).toBeUndefined();
    expect(childEnv.PATH).toBeTruthy();
  });

  test('safeChildEnv + env-dumper live-exec', () => {
    const ENV_DUMPER_JS = join(
      dirname(fileURLToPath(import.meta.url)),
      'fixtures', 'stub-cli', 'env-dumper.js'
    );

    const childEnv = safeChildEnv({ ACP_CONVERSATION_ID: 'conv-live' }, {
      source: {
        PATH: process.env.PATH || '',
        ACP_LOCAL_SECRET: 'live-secret-here',
        VIBESQL_CONTAINER_SECRET: 'another-live-secret',
        MY_RANDOM_VAR: 'should-not-appear',
      },
    });

    let stderr = '';
    try {
      execFileSync(process.execPath, [ENV_DUMPER_JS, 'MY_RANDOM_VAR'], {
        encoding: 'utf8',
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      stderr = err.stderr || '';
    }

    // ACP_CONVERSATION_ID was injected
    expect(stderr).toContain('ACP_CONVERSATION_ID=conv-live');
    // ACP_LOCAL_SECRET was stripped
    expect(stderr).not.toContain('live-secret-here');
    expect(stderr).not.toContain('ACP_LOCAL_SECRET=');
    // MY_RANDOM_VAR was stripped (not in allowlist and not injected)
    expect(stderr).not.toContain('MY_RANDOM_VAR=');
  });
});
