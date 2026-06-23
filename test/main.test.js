import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../bin/index.js';

test('run writes Usage error to stderr and calls exit(1) on missing argument', async () => {
  const stderrChunks = [];
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderrChunks.push(chunk); return true; };

  let exitCode;
  const origExit = process.exit.bind(process);
  process.exit = (code) => { exitCode = code; throw new Error(`exit:${code}`); };

  try {
    await run(['node', 'script']);
  } catch (e) {
    if (!e.message.startsWith('exit:')) throw e;
  } finally {
    process.stderr.write = origStderrWrite;
    process.exit = origExit;
  }

  assert.equal(exitCode, 1);
  assert.ok(stderrChunks.join('').includes('Usage:'));
});
