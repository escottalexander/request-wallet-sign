import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, writeState, clearState, isPidAlive } from '../bin/index.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aws-')); process.env.AGENT_WALLET_SIGNER_HOME = dir; });
afterEach(() => { delete process.env.AGENT_WALLET_SIGNER_HOME; rmSync(dir, { recursive: true, force: true }); });

test('readState returns null when no file', () => {
  assert.equal(readState(), null);
});

test('writeState then readState round-trips', () => {
  writeState({ port: 8456, url: 'https://x.trycloudflare.com', pid: 1, startedAt: 1, lastUsedAt: 2 });
  assert.deepEqual(readState(), { port: 8456, url: 'https://x.trycloudflare.com', pid: 1, startedAt: 1, lastUsedAt: 2 });
});

test('clearState removes the file', () => {
  writeState({ port: 8456, url: 'u', pid: 1, startedAt: 1, lastUsedAt: 2 });
  clearState();
  assert.equal(readState(), null);
});

test('isPidAlive is true for current process, false for unused pid', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(999999999), false);
  assert.equal(isPidAlive(undefined), false);
});
