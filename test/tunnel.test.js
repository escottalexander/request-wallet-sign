import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTunnelUrl } from '../bin/index.js';

test('extractTunnelUrl pulls the trycloudflare URL from log noise', () => {
  const log = 'INF Requesting new quick Tunnel on trycloudflare.com...\n' +
    'INF |  https://services-proud-voice.trycloudflare.com  |';
  assert.equal(extractTunnelUrl(log), 'https://services-proud-voice.trycloudflare.com');
});

test('extractTunnelUrl returns null when no URL present', () => {
  assert.equal(extractTunnelUrl('nothing here'), null);
});
