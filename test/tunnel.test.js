import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTunnelUrl, createTunnelController } from '../bin/index.js';

test('extractTunnelUrl pulls the trycloudflare URL from log noise', () => {
  const log = 'INF Requesting new quick Tunnel on trycloudflare.com...\n' +
    'INF |  https://services-proud-voice.trycloudflare.com  |';
  assert.equal(extractTunnelUrl(log), 'https://services-proud-voice.trycloudflare.com');
});

test('extractTunnelUrl returns null when no URL present', () => {
  assert.equal(extractTunnelUrl('nothing here'), null);
});

function fakeDeps(overrides = {}) {
  const calls = { written: [], started: 0 };
  return {
    calls,
    deps: {
      now: () => 1000,
      readState: () => overrides.state ?? null,
      writeState: s => calls.written.push(s),
      isPidAlive: () => overrides.alive ?? false,
      startCloudflared: async () => { calls.started++; return 'startResult' in overrides ? overrides.startResult : { url: 'https://new.trycloudflare.com', pid: 42 }; },
      probeUrl: async () => overrides.reachable ?? true,
      log: () => {},
    },
  };
}

test('controller.start starts a new tunnel when no state', async () => {
  const { deps, calls } = fakeDeps();
  const c = createTunnelController(8456, deps);
  const out = await c.start();
  assert.equal(out.url, 'https://new.trycloudflare.com');
  assert.equal(calls.started, 1);
  assert.equal(calls.written[0].pid, 42);
});

test('controller.start reuses a live fresh same-port tunnel', async () => {
  const { deps, calls } = fakeDeps({
    state: { port: 8456, url: 'https://old.trycloudflare.com', pid: 7, startedAt: 0, lastUsedAt: 1000 },
    alive: true,
  });
  const c = createTunnelController(8456, deps);
  const out = await c.start();
  assert.equal(out.url, 'https://old.trycloudflare.com');
  assert.equal(calls.started, 0);
});

test('controller.start returns error when cloudflared yields no URL', async () => {
  const { deps } = fakeDeps({ startResult: null });
  const c = createTunnelController(8456, deps);
  assert.ok((await c.start()).error);
});

test('controller.check reports reachability of stored url', async () => {
  const { deps } = fakeDeps({ state: { url: 'https://x.trycloudflare.com' }, reachable: false });
  const c = createTunnelController(8456, deps);
  assert.deepEqual(await c.check(), { reachable: false });
});
