import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { symlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = resolve(fileURLToPath(new URL('../bin/index.js', import.meta.url)));

// Regression: when installed (npx / global), the bin runs through a symlink in
// node_modules/.bin. The entry-point guard must still detect "run as main" and
// actually execute, or the CLI exits silently doing nothing.
test('CLI executes when invoked through a bin symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rws-cli-'));
  try {
    const link = join(dir, 'request-wallet-sign');
    symlinkSync(bin, link);
    const out = execFileSync('node', [link, '--help'], { encoding: 'utf8' });
    assert.match(out, /request-wallet-sign/);
    assert.match(out, /USAGE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI executes when invoked directly', () => {
  const out = execFileSync('node', [bin, '--help'], { encoding: 'utf8' });
  assert.match(out, /USAGE/);
});
