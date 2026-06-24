import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, writeState, clearState, isPidAlive, decideTunnelAction, TUNNEL_TTL_MS, stopTunnel } from '../bin/index.js';

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

test('decideTunnelAction: no state -> start', () => {
  assert.equal(decideTunnelAction(null, 8456, 1000, false).action, 'start');
});

test('decideTunnelAction: live, fresh, same port -> reuse', () => {
  const state = { port: 8456, url: 'https://x.trycloudflare.com', pid: 5, startedAt: 0, lastUsedAt: 1000 };
  const d = decideTunnelAction(state, 8456, 1000 + TUNNEL_TTL_MS - 1, true);
  assert.equal(d.action, 'reuse');
  assert.equal(d.url, 'https://x.trycloudflare.com');
});

test('decideTunnelAction: stale -> replace with pid', () => {
  const state = { port: 8456, url: 'u', pid: 5, startedAt: 0, lastUsedAt: 1000 };
  const d = decideTunnelAction(state, 8456, 1000 + TUNNEL_TTL_MS, true);
  assert.equal(d.action, 'replace');
  assert.equal(d.pid, 5);
});

test('decideTunnelAction: dead pid -> start', () => {
  const state = { port: 8456, url: 'u', pid: 5, startedAt: 0, lastUsedAt: 1000 };
  assert.equal(decideTunnelAction(state, 8456, 1000, false).action, 'start');
});

test('decideTunnelAction: live but different port -> start', () => {
  const state = { port: 9999, url: 'u', pid: 5, startedAt: 0, lastUsedAt: 1000 };
  assert.equal(decideTunnelAction(state, 8456, 1000, true).action, 'start');
});

test('stopTunnel kills the tracked pid and clears state', () => {
  let killed = null;
  writeState({ port: 8456, url: 'https://x.trycloudflare.com', pid: 123, startedAt: 0, lastUsedAt: 0 });
  const url = stopTunnel({ kill: pid => { killed = pid; } });
  assert.equal(killed, 123);
  assert.equal(url, 'https://x.trycloudflare.com');
  assert.equal(readState(), null);
});
