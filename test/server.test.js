import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findAvailablePort, startServer, getLocalNetworkIP } from '../bin/index.js';

test('findAvailablePort returns a valid port number', async () => {
  const port = await findAvailablePort();
  assert.ok(typeof port === 'number');
  assert.ok(port > 1024 && port < 65535);
});

test('findAvailablePort returns a port we can actually bind', async () => {
  const port = await findAvailablePort();
  // startServer will throw/hang if port is already taken
  const { close } = startServer(port, '<html></html>');
  // If we got here without throwing, the port was usable
  close();
});

test('startServer serves HTML at GET /', async () => {
  const port = await findAvailablePort();
  const { close } = startServer(port, '<html>hello</html>');

  const res = await fetch(`http://localhost:${port}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  const body = await res.text();
  assert.ok(body.includes('hello'));

  close();
});

test('startServer resolves result promise on POST /result', async () => {
  const port = await findAvailablePort();
  const { result, close } = startServer(port, '<html></html>');

  const payload = { hash: '0xabc123', chainId: 1 };
  await fetch(`http://localhost:${port}/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const resolved = await result;
  assert.deepEqual(resolved, payload);
  close();
});

test('startServer routes /tunnel/start and /tunnel/check to the controller', async () => {
  const port = await findAvailablePort();
  const fakeTunnel = {
    start: async () => ({ url: 'https://x.trycloudflare.com' }),
    check: async () => ({ reachable: true }),
  };
  const { close } = startServer(port, '<html></html>', fakeTunnel);
  const s = await (await fetch(`http://localhost:${port}/tunnel/start`, { method: 'POST' })).json();
  assert.equal(s.url, 'https://x.trycloudflare.com');
  const c = await (await fetch(`http://localhost:${port}/tunnel/check`, { method: 'POST' })).json();
  assert.equal(c.reachable, true);
  close();
});

test('startServer returns 404 for unknown routes', async () => {
  const port = await findAvailablePort();
  const { close } = startServer(port, '<html></html>');

  const res = await fetch(`http://localhost:${port}/unknown`);
  assert.equal(res.status, 404);
  close();
});

test('tunnel endpoints reject non-loopback clients', async () => {
  const ip = getLocalNetworkIP();
  if (!ip) return; // no LAN interface available; skip
  const port = await findAvailablePort();
  const fakeTunnel = { start: async () => ({ url: 'x' }), check: async () => ({ reachable: true }) };
  const { close } = startServer(port, '<html></html>', fakeTunnel);
  const res = await fetch(`http://${ip}:${port}/tunnel/start`, { method: 'POST' });
  assert.equal(res.status, 403);
  close();
});

test('tunnel endpoints allow loopback clients', async () => {
  const port = await findAvailablePort();
  const fakeTunnel = { start: async () => ({ url: 'https://x.trycloudflare.com' }), check: async () => ({ reachable: true }) };
  const { close } = startServer(port, '<html></html>', fakeTunnel);
  const res = await fetch(`http://127.0.0.1:${port}/tunnel/start`, { method: 'POST' });
  assert.equal(res.status, 200);
  close();
});
