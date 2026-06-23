import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findAvailablePort, startServer } from '../bin/index.js';

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

test('startServer returns 404 for unknown routes', async () => {
  const port = await findAvailablePort();
  const { close } = startServer(port, '<html></html>');

  const res = await fetch(`http://localhost:${port}/unknown`);
  assert.equal(res.status, 404);
  close();
});
