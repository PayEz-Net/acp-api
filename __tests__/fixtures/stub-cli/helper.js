import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

export function resolveStubPath(name) {
  const ext = process.platform === 'win32' ? '.cmd' : '.sh';
  return join(FIXTURE_DIR, `${name}${ext}`);
}

export const STUB_NAMES = Object.freeze([
  'happy-path',
  'env-dumper',
  'path-dumper',
  'unauthed',
  'ansi-colored',
]);
