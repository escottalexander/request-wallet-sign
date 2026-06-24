import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { isPortFree, choosePort, findAvailablePort } from '../bin/index.js';

test('isPortFree true for an unused port, false when taken', async () => {
  const port = await findAvailablePort();
  assert.equal(await isPortFree(port), true);
  const srv = createServer().listen(port, '0.0.0.0');
  await new Promise(r => srv.once('listening', r));
  assert.equal(await isPortFree(port), false);
  await new Promise(r => srv.close(r));
});

test('choosePort returns preferred when free', async () => {
  const port = await findAvailablePort();
  assert.equal(await choosePort(port), port);
});

test('choosePort falls back to a different free port when preferred is taken', async () => {
  const port = await findAvailablePort();
  const srv = createServer().listen(port, '0.0.0.0');
  await new Promise(r => srv.once('listening', r));
  const chosen = await choosePort(port);
  assert.notEqual(chosen, port);
  assert.equal(typeof chosen, 'number');
  await new Promise(r => srv.close(r));
});
