import { describe, it, expect } from '@jest/globals';
import { scrubOutput, buildDefaultScrubContext } from '../outputScrubber.js';

const HOME = process.platform === 'win32' ? 'C:\\Users\\testuser' : '/home/testuser';

function ctx(overrides: Partial<ReturnType<typeof buildDefaultScrubContext>> = {}) {
  return {
    secretValues: [] as string[],
    homeDirs: [HOME],
    ...overrides,
  };
}

describe('outputScrubber', () => {
  it('redacts exact ACP secret values', () => {
    const secret = 'super-sensitive-token-value-12345';
    const out = scrubOutput(`echo ${secret} done`, ctx({ secretValues: [secret] }));
    expect(out).not.toContain(secret);
    expect(out).toContain('<acp-env>');
    expect(out).toContain('done');
  });

  it('redacts user home path', () => {
    const out = scrubOutput(`cd ${HOME}/project`, ctx());
    expect(out).not.toContain(HOME);
    expect(out).toBe('cd <home>/project');
  });

  it('redacts provider API keys adjacent to key/token/secret/api', () => {
    const key = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const out = scrubOutput(`api_key=${key}`, ctx());
    expect(out).not.toContain(key);
    expect(out).toBe('api_key=<secret>');
  });

  it('redacts sk-... style keys standalone', () => {
    const key = 'sk-proj-abc123def456ghi789jkl012mno345pqr';
    const out = scrubOutput(`using key ${key} now`, ctx());
    expect(out).not.toContain(key);
    expect(out).toBe('using key <secret> now');
  });

  it('redacts token-like values after a token keyword', () => {
    const token = 'x'.repeat(40);
    const out = scrubOutput(`token: ${token}`, ctx());
    expect(out).not.toContain(token);
    expect(out).toBe('token=<secret>');
  });

  it('redacts .env-style secret assignments', () => {
    const value = 'shh-do-not-leak';
    const out = scrubOutput(`export CLAUDE_API_SECRET=${value}`, ctx());
    expect(out).not.toContain(value);
    expect(out).toBe('export CLAUDE_API_SECRET=<env>');
  });

  it('does not redact short non-secret env assignments', () => {
    const out = scrubOutput(`MODE=ok`, ctx());
    expect(out).toBe('MODE=ok');
  });

  it('does not redact standalone long hex hashes without secret keywords', () => {
    const hash = 'a'.repeat(64);
    const out = scrubOutput(`commit ${hash}`, ctx());
    expect(out).toContain(hash);
  });
});
