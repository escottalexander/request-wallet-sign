import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest } from '../bin/index.js';

test('throws when no argument provided', () => {
  assert.throws(() => parseRequest(['node', 'script']), /Usage:/);
});

test('throws on invalid JSON', () => {
  assert.throws(() => parseRequest(['node', 'script', '{bad json']), /Invalid JSON/);
});

test('throws when chainId is missing', () => {
  assert.throws(
    () => parseRequest(['node', 'script', '{"to":"0x1234"}']),
    /chainId/
  );
});

test('throws when chainId is not an integer', () => {
  assert.throws(
    () => parseRequest(['node', 'script', '{"chainId":"1","to":"0x1234"}']),
    /chainId/
  );
});

test('infers sendTransaction from to+chainId', () => {
  const req = parseRequest(['node', 's', JSON.stringify({ chainId: 1, to: '0xabc' })]);
  assert.equal(req._type, 'sendTransaction');
  assert.equal(req.chainId, 1);
});

test('infers sendTransaction for deployment (data only, no to)', () => {
  const req = parseRequest(['node', 's', JSON.stringify({ chainId: 1, data: '0xdeadbeef' })]);
  assert.equal(req._type, 'sendTransaction');
});

test('infers signTypedData when typedData present', () => {
  const req = parseRequest(['node', 's', JSON.stringify({
    chainId: 1,
    typedData: { domain: {}, types: {}, primaryType: 'Foo', message: {} }
  })]);
  assert.equal(req._type, 'signTypedData');
});

test('infers personalSign when message present', () => {
  const req = parseRequest(['node', 's', JSON.stringify({ chainId: 1, message: 'hello' })]);
  assert.equal(req._type, 'personalSign');
});

test('typedData wins over message when both present', () => {
  const req = parseRequest(['node', 's', JSON.stringify({
    chainId: 1,
    typedData: { domain: {}, types: {}, primaryType: 'Foo', message: {} },
    message: 'ignored'
  })]);
  assert.equal(req._type, 'signTypedData');
});

test('preserves label and description', () => {
  const req = parseRequest(['node', 's', JSON.stringify({
    chainId: 1, to: '0xabc', label: 'My Label', description: 'My Desc'
  })]);
  assert.equal(req.label, 'My Label');
  assert.equal(req.description, 'My Desc');
});

test('defaults value to 0x0 for sendTransaction', () => {
  const req = parseRequest(['node', 's', JSON.stringify({ chainId: 1, to: '0xabc' })]);
  assert.equal(req.value, '0x0');
});

test('preserves explicit value when provided', () => {
  const req = parseRequest(['node', 's', JSON.stringify({ chainId: 1, to: '0xabc', value: '0xde0b6b3a7640000' })]);
  assert.equal(req.value, '0xde0b6b3a7640000');
});
