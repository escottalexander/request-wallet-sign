import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DECODE_HELPERS_JS } from '../bin/index.js';

const H = new Function(DECODE_HELPERS_JS + `
  return { awsTrunc, awsFormatAmount, awsIsUnlimited, awsParseSignature,
           awsPlaceholderTitle, awsDescriptorIndexUrl, awsFormatDescriptorField, awsDescribeCall };`)();

test('awsFormatAmount applies decimals and trims zeros', () => {
  assert.equal(H.awsFormatAmount('1500000', 6), '1.5');
  assert.equal(H.awsFormatAmount('1000000000000000000', 18), '1');
  assert.equal(H.awsFormatAmount('0', 18), '0');
});

test('awsIsUnlimited flags near-max approvals', () => {
  assert.equal(H.awsIsUnlimited((2n ** 256n - 1n).toString()), true);
  assert.equal(H.awsIsUnlimited('1000000'), false);
});

test('awsParseSignature splits name and types', () => {
  assert.deepEqual(H.awsParseSignature('transfer(address,uint256)'), { name: 'transfer', types: ['address', 'uint256'] });
  assert.deepEqual(H.awsParseSignature('claim()'), { name: 'claim', types: [] });
});

test('awsPlaceholderTitle covers op types', () => {
  assert.equal(H.awsPlaceholderTitle('sendTransaction'), 'Review transaction');
  assert.equal(H.awsPlaceholderTitle('personalSign'), 'Review message');
  assert.equal(H.awsPlaceholderTitle('signTypedData'), 'Review typed-data signature');
});

test('awsDescriptorIndexUrl points at the registry raw index', () => {
  assert.match(H.awsDescriptorIndexUrl('calldata'), /index\.calldata\.json$/);
  assert.match(H.awsDescriptorIndexUrl('eip712'), /index\.eip712\.json$/);
  assert.match(H.awsDescriptorIndexUrl('calldata'), /^https:\/\//);
});

test('awsDescribeCall renders ERC-20 transfer with token metadata', () => {
  const r = H.awsDescribeCall({ signature: 'transfer(address,uint256)',
    args: ['0xdddddddddddddddddddddddddddddddddddddddd', '25000000'], symbol: 'USDC', decimals: 6 });
  assert.match(r.title, /Send 25 USDC/);
  assert.ok(r.fields.some(f => /0xdddd/i.test(f.value)));
});

test('awsDescribeCall flags unlimited approve', () => {
  const r = H.awsDescribeCall({ signature: 'approve(address,uint256)',
    args: ['0xspender0000000000000000000000000000000000', (2n ** 256n - 1n).toString()], symbol: 'USDC', decimals: 6 });
  assert.match(r.title, /Approve/);
  assert.ok(r.fields.some(f => f.danger && /unlimited/i.test(f.value)));
});

test('awsDescribeCall flags setApprovalForAll(true)', () => {
  const r = H.awsDescribeCall({ signature: 'setApprovalForAll(address,bool)',
    args: ['0xoperator000000000000000000000000000000000', true] });
  assert.ok(r.fields.some(f => f.danger));
  assert.match(r.title, /all/i);
});

test('awsDescribeCall returns null for unknown signatures', () => {
  assert.equal(H.awsDescribeCall({ signature: 'frobnicate(uint256)', args: ['1'] }), null);
});

test('awsFormatDescriptorField handles tokenAmount and falls back', () => {
  assert.equal(H.awsFormatDescriptorField('tokenAmount', '1500000', { decimals: 6, ticker: 'USDC' }), '1.5 USDC');
  assert.equal(H.awsFormatDescriptorField('raw', 'hello', {}), 'hello');
  assert.equal(H.awsFormatDescriptorField('weirdformat', 'x', {}), 'x');
});
