import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHtml, parseRequest } from '../bin/index.js';

function makeReq(extra = {}) {
  return parseRequest(['node', 's', JSON.stringify({ chainId: 1, to: '0xabc', label: 'Test', ...extra })]);
}

test('HTML contains DOCTYPE and charset', () => {
  const html = buildHtml(makeReq(), 3000);
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('charset="utf-8"'));
});

test('HTML contains REQUEST global with chainId', () => {
  const html = buildHtml(makeReq(), 3000);
  assert.ok(html.includes('"chainId":1'));
});

test('HTML contains relative RESULT_URL', () => {
  const html = buildHtml(makeReq(), 4242);
  assert.ok(html.includes("'/result'"));
});

test('HTML has a data-derived headline element and no agent label', () => {
  const html = buildHtml(makeReq({ label: 'Totally Safe', description: 'trust me' }), 3000);
  assert.ok(html.includes('id="headline"'));
  assert.ok(!html.includes('Totally Safe'));
  assert.ok(!html.includes('trust me'));
});

test('HTML contains connect wallet button with id=btn', () => {
  const html = buildHtml(makeReq(), 3000);
  assert.ok(html.includes('id="btn"'));
});

test('HTML contains all required data-show sections', () => {
  const html = buildHtml(makeReq(), 3000);
  for (const state of ['ready', 'waiting', 'done', 'error', 'no-wallet']) {
    assert.ok(html.includes(`data-show="${state}"`), `missing data-show="${state}"`);
  }
});

test('HTML contains CHAIN_META global', () => {
  const html = buildHtml(makeReq(), 3000);
  assert.ok(html.includes('CHAIN_META'));
  assert.ok(html.includes('Ethereum'));
});

test('HTML contains wallet_switchEthereumChain call', () => {
  const html = buildHtml(makeReq(), 3000);
  assert.ok(html.includes('wallet_switchEthereumChain'));
});

test('HTML contains wallet_addEthereumChain call', () => {
  const html = buildHtml(makeReq(), 3000);
  assert.ok(html.includes('wallet_addEthereumChain'));
});

test('HTML contains eth_estimateGas call', () => {
  const html = buildHtml(makeReq(), 3000);
  assert.ok(html.includes('eth_estimateGas'));
});

test('HTML contains eth_maxPriorityFeePerGas call', () => {
  const html = buildHtml(makeReq(), 3000);
  assert.ok(html.includes('eth_maxPriorityFeePerGas'));
});

test('HTML contains eth_getBlockByNumber call for baseFee', () => {
  const html = buildHtml(makeReq(), 3000);
  assert.ok(html.includes('eth_getBlockByNumber'));
  assert.ok(html.includes('baseFeePerGas'));
});

test('HTML contains eth_sendTransaction call', () => {
  const html = buildHtml(makeReq(), 3000);
  assert.ok(html.includes('eth_sendTransaction'));
});

test('HTML contains eth_signTypedData_v4 call', () => {
  const req = parseRequest(['n', 's', JSON.stringify({
    chainId: 1,
    typedData: { domain: {}, types: {}, primaryType: 'X', message: {} }
  })]);
  const html = buildHtml(req, 3000);
  assert.ok(html.includes('eth_signTypedData_v4'));
});

test('HTML contains personal_sign call', () => {
  const req = parseRequest(['n', 's', JSON.stringify({ chainId: 1, message: 'hi' })]);
  const html = buildHtml(req, 3000);
  assert.ok(html.includes('personal_sign'));
});

test('HTML uses type 0x2 for EIP-1559 transactions', () => {
  const html = buildHtml(makeReq(), 3000);
  assert.ok(html.includes("'0x2'") || html.includes('"0x2"'));
});

test('HTML imports whatsabi from esm.sh CDN', () => {
  const html = buildHtml(makeReq({ data: '0xa9059cbb0000' }), 3000);
  assert.ok(html.includes('esm.sh'));
  assert.ok(html.includes('@shazow/whatsabi'));
});

test('HTML handles contract deployment with no to address', () => {
  const req = parseRequest(['n', 's', JSON.stringify({ chainId: 1, data: '0x6080604052' })]);
  const html = buildHtml(req, 3000);
  assert.ok(html.includes('deployment') || html.includes('bytes'));
});

test('HTML injects pure decode helpers and the what-this-does container', () => {
  const html = buildHtml(makeReq(), 3000);
  assert.ok(html.includes('function awsDescribeCall'));
  assert.ok(html.includes('id="what"'));
});

test('HTML decode pipeline uses ERC-7730, openchain signature lookup, and viem', () => {
  const html = buildHtml(makeReq(), 3000);
  assert.ok(html.includes('renderWhatThisDoes'));
  assert.ok(html.includes('OpenChainSignatureLookup'));
  assert.ok(html.includes('tryCalldataDescriptor'));
});

test('HTML sends type-4 and relays authorizationList for EIP-7702', () => {
  const html = buildHtml(makeReq(), 3000);
  assert.ok(html.includes("'0x4'"));                 // type-4 selected when auth present
  assert.ok(html.includes('tx.authorizationList'));  // relayed through eth_sendTransaction
  assert.ok(html.includes('Authorize account delegation')); // surfaced in the decode
});

test('HTML formats value as ETH not wei', () => {
  const html = buildHtml(makeReq(), 3000);
  assert.ok(html.includes('formatEther'));
  assert.ok(!html.includes('wei`'));
});

test('HTML includes Sepolia in chain metadata', () => {
  const html = buildHtml(makeReq({ chainId: 11155111 }), 3000);
  assert.ok(html.includes('Sepolia'));
});

test('HTML has copy-all and clipboard support', () => {
  const html = buildHtml(makeReq(), 3000);
  assert.ok(html.includes('copy-all-btn'));
  assert.ok(html.includes('function copyText'));
  assert.ok(html.includes('txDataText'));
});

test('HTML marks "to" value as copyable', () => {
  const html = buildHtml(makeReq(), 3000);
  assert.ok(html.includes('copyable'));
});

test('HTML includes network URL copy button when networkUrl provided', () => {
  const html = buildHtml(makeReq(), 3000, 'http://192.168.1.5:3000');
  assert.ok(html.includes('id="copy-url-btn"'));
});

test('HTML shows the cross-device button', () => {
  const html = buildHtml(makeReq(), 3000, 'http://192.168.1.5:3000');
  assert.ok(html.includes('id="cross-device-btn"'));
});

test('HTML references the tunnel endpoints', () => {
  const html = buildHtml(makeReq(), 3000, 'http://192.168.1.5:3000');
  assert.ok(html.includes('/tunnel/start'));
  assert.ok(html.includes('/tunnel/check'));
});

test('HTML auto-starts tunnel only when opts.autoTunnel is set', () => {
  assert.ok(buildHtml(makeReq(), 3000, null, { autoTunnel: true }).includes('AUTO_TUNNEL = true'));
  assert.ok(buildHtml(makeReq(), 3000, null).includes('AUTO_TUNNEL = false'));
});

test('HTML fee estimation falls back when eth_maxPriorityFeePerGas unavailable', () => {
  const html = buildHtml(makeReq(), 3000);
  // The priority-fee call must be wrapped so an unsupported method degrades gracefully
  assert.ok(html.includes('1500000000n'));
});
