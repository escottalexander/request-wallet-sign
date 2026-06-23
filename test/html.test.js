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

test('HTML contains RESULT_URL pointing to correct port', () => {
  const html = buildHtml(makeReq(), 4242);
  assert.ok(html.includes('http://localhost:4242/result'));
});

test('HTML contains label in page title', () => {
  const html = buildHtml(makeReq({ label: 'My Signing Request' }), 3000);
  assert.ok(html.includes('My Signing Request'));
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

test('HTML escapes label to prevent XSS', () => {
  const html = buildHtml(makeReq({ label: '<script>alert(1)</script>' }), 3000);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('HTML contains CHAIN_META global', () => {
  const html = buildHtml(makeReq(), 3000);
  assert.ok(html.includes('CHAIN_META'));
  assert.ok(html.includes('Ethereum'));
});
