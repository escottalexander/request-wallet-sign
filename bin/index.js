#!/usr/bin/env node

// ── Request parsing ───────────────────────────────────────────────────────────

// Parse CLI options (flags) from argv, separate from the request JSON.
export function parseOptions(argv) {
  const args = argv.slice(2);
  return {
    tunnel: args.includes('--tunnel'),
    stopTunnel: args.includes('--stop-tunnel'),
  };
}

export function parseRequest(argv) {
  // The request JSON is the first argument that isn't a --flag.
  const raw = argv.slice(2).find(a => !a.startsWith('--'));
  if (!raw) {
    throw new Error("Usage: request-wallet-sign [--tunnel] '<request JSON>'");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e.message}`);
  }

  if (typeof parsed.chainId !== 'number' || !Number.isInteger(parsed.chainId)) {
    throw new Error('Request must include "chainId" as an integer (e.g. 1 for Ethereum mainnet)');
  }

  // Infer operation type — typedData > message > sendTransaction
  let _type;
  if (parsed.typedData !== undefined) {
    _type = 'signTypedData';
  } else if (parsed.message !== undefined) {
    _type = 'personalSign';
  } else {
    _type = 'sendTransaction';
  }

  const req = { ...parsed, _type };

  // Agent-supplied free text is untrusted and must never be shown as if it
  // described the transaction; the page derives its summary from the data.
  delete req.label;
  delete req.description;

  // Default value for sendTransaction
  if (_type === 'sendTransaction' && req.value === undefined) {
    req.value = '0x0';
  }

  return req;
}

// ── Port finding ──────────────────────────────────────────────────────────────

import { createServer as createNetServer } from 'node:net';
import { networkInterfaces, homedir } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, rmSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';

function stateDir() {
  return process.env.REQUEST_WALLET_SIGN_HOME || join(homedir(), '.request-wallet-sign');
}
function stateFilePath() { return join(stateDir(), 'state.json'); }

export function readState() {
  try { return JSON.parse(readFileSync(stateFilePath(), 'utf8')); }
  catch { return null; }
}
export function writeState(state) {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(stateFilePath(), JSON.stringify(state));
}
export function clearState() {
  try { rmSync(stateFilePath()); } catch {}
}
export function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // alive but owned by another user
}

export const TUNNEL_TTL_MS = 10 * 60 * 1000;

// Pure: caller passes `alive` (computed via isPidAlive) so this stays testable.
export function decideTunnelAction(state, port, now, alive, ttl = TUNNEL_TTL_MS) {
  if (!state || !state.url || !alive) return { action: 'start' };
  if (now - state.lastUsedAt >= ttl) return { action: 'replace', pid: state.pid };
  if (state.port !== port) return { action: 'start' };
  return { action: 'reuse', url: state.url };
}

export function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, '0.0.0.0', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export function isPortFree(port) {
  return new Promise(resolve => {
    const srv = createNetServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '0.0.0.0', () => srv.close(() => resolve(true)));
  });
}

export async function choosePort(preferred) {
  if (await isPortFree(preferred)) return preferred;
  return findAvailablePort();
}

export function getLocalNetworkIP() {
  const nets = networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

// ── HTTP server ───────────────────────────────────────────────────────────────

import { createServer as createHttpServer } from 'node:http';

function isLoopbackReq(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

export function startServer(port, html, tunnel) {
  let resolveResult, rejectResult;
  const result = new Promise((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });

  const server = createHttpServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else if (req.method === 'POST' && req.url === '/result') {
      let body = '';
      const maxBodySize = 64 * 1024; // 64KB limit
      req.on('data', chunk => {
        body += chunk;
        if (body.length > maxBodySize) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end('{"error":"body too large"}');
          req.destroy();
          rejectResult(new Error('result body too large'));
        }
      });
      req.on('end', () => {
        if (body.length <= maxBodySize) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
          try {
            resolveResult(JSON.parse(body));
          } catch (e) {
            rejectResult(new Error(`Bad result payload: ${e.message}`));
          }
        }
      });
    } else if (req.method === 'POST' && req.url === '/tunnel/start' && tunnel) {
      if (!isLoopbackReq(req)) { res.writeHead(403); res.end(); return; }
      const out = await tunnel.start();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    } else if (req.method === 'POST' && req.url === '/tunnel/check' && tunnel) {
      if (!isLoopbackReq(req)) { res.writeHead(403); res.end(); return; }
      const out = await tunnel.check();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, '0.0.0.0');
  server.on('error', (err) => {
    rejectResult(err);
  });
  return { result, close: () => server.close() };
}

// ── Browser open ──────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process';

export function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32'  ? 'start' :
    'xdg-open';
  spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
}

// ── Cloudflare tunnel primitives ────────────────────────────────────────────
export function extractTunnelUrl(text) {
  const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  return m ? m[0] : null;
}

function cloudflaredLogPath() { return join(stateDir(), 'cloudflared.log'); }

// Spawn a DETACHED cloudflared quick tunnel that survives CLI exit (for reuse).
// cloudflared's stdio goes to a LOG FILE — not parent pipes — so the process is
// not killed by SIGPIPE when the CLI exits after signing. We scrape the URL by
// polling that log file. Resolves { url, pid } or null on failure/timeout.
function startCloudflared(port) {
  return new Promise(resolve => {
    let settled = false;
    const finish = (proc, url) => {
      if (settled) return;
      settled = true;
      if (url) resolve({ url, pid: proc.pid });
      else { try { proc.kill(); } catch {} resolve(null); }
    };
    try {
      mkdirSync(stateDir(), { recursive: true });
      const logPath = cloudflaredLogPath();
      const fd = openSync(logPath, 'w');
      const proc = spawn('npx', ['-y', 'cloudflared', 'tunnel', '--url', `http://127.0.0.1:${port}`],
        { detached: true, stdio: ['ignore', fd, fd] });
      closeSync(fd); // child holds its own dup; parent doesn't need it
      proc.on('error', () => finish(proc, null));
      proc.unref();
      const deadline = Date.now() + 25000;
      const tick = () => {
        if (settled) return;
        let txt = '';
        try { txt = readFileSync(logPath, 'utf8'); } catch {}
        const u = extractTunnelUrl(txt);
        if (u) return finish(proc, u);
        if (Date.now() > deadline) return finish(proc, null);
        setTimeout(tick, 400);
      };
      setTimeout(tick, 400);
    } catch {
      resolve(null);
    }
  });
}

async function probeUrl(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return r.status === 200;
  } catch { return false; }
}

export function createTunnelController(port, deps = {}) {
  const read      = deps.readState       || readState;
  const write     = deps.writeState      || writeState;
  const alive     = deps.isPidAlive      || isPidAlive;
  const startProc = deps.startCloudflared || startCloudflared;
  const probe     = deps.probeUrl        || probeUrl;
  const now       = deps.now             || (() => Date.now());
  const log       = deps.log             || (() => {});
  const clear     = deps.clearState      || clearState;
  const kill      = deps.kill            || killTunnelTree;
  return {
    async start() {
      const t = now();
      const state = read();
      const decision = decideTunnelAction(state, port, t, alive(state && state.pid));
      if (decision.action === 'reuse') {
        write({ ...state, lastUsedAt: t });
        log(`reusing tunnel ${decision.url}`);
        return { url: decision.url };
      }
      if (decision.action === 'replace' && decision.pid) {
        kill(decision.pid);
      }
      const res = await startProc(port);
      if (!res) { clear(); return { error: 'could not start tunnel' }; }
      write({ port, url: res.url, pid: res.pid, startedAt: t, lastUsedAt: t });
      log(`started tunnel ${res.url}`);
      return { url: res.url };
    },
    async check() {
      const state = read();
      if (!state || !state.url) return { reachable: false };
      return { reachable: await probe(state.url) };
    },
  };
}

// Kill the cloudflared process GROUP. It is spawned detached (its own group
// leader, pgid === pid), so a negative pid reaches the npx wrapper AND the real
// cloudflared child; killing just the pid would orphan the child.
function killTunnelTree(pid) {
  try { process.kill(-pid); } catch {}
  try { process.kill(pid); } catch {}
}

export function stopTunnel(deps = {}) {
  const read  = deps.readState  || readState;
  const clear = deps.clearState || clearState;
  const kill  = deps.kill       || killTunnelTree;
  const state = read();
  if (state && state.pid) { try { kill(state.pid); } catch {} }
  clear();
  return state ? state.url : null;
}

// ── Clear-signing decode helpers (pure JS, injected into the browser page) ─────

export const DECODE_HELPERS_JS = `
function awsTrunc(a){ return a ? a.slice(0,6) + '\\u2026' + a.slice(-4) : '\\u2014'; }
function awsFormatAmount(rawDecimal, decimals){
  const d = BigInt(decimals||0); const neg = String(rawDecimal).startsWith('-');
  let v = BigInt(neg ? String(rawDecimal).slice(1) : rawDecimal);
  const base = 10n ** d; const whole = v / base; let frac = (v % base).toString().padStart(Number(d),'0').replace(/0+$/,'');
  return (neg?'-':'') + whole.toString() + (frac ? '.' + frac : '');
}
function awsIsUnlimited(rawDecimal){ try { return BigInt(rawDecimal) >= (2n ** 255n); } catch { return false; } }
function awsParseSignature(sig){
  const m = String(sig).match(/^([^(]+)\\((.*)\\)$/); if(!m) return { name: String(sig), types: [] };
  const types = m[2].trim() ? m[2].split(',').map(s=>s.trim()) : [];
  return { name: m[1], types };
}
function awsPlaceholderTitle(opType){
  return opType === 'personalSign' ? 'Review message'
       : opType === 'signTypedData' ? 'Review typed-data signature'
       : 'Review transaction';
}
function awsDescriptorIndexUrl(kind){
  return 'https://raw.githubusercontent.com/ethereum/clear-signing-erc7730-registry/master/registry/index.' + kind + '.json';
}
function awsFormatDescriptorField(format, value, params){
  params = params || {};
  if (format === 'tokenAmount' || format === 'amount'){
    const dec = params.decimals != null ? params.decimals : 18;
    const s = awsFormatAmount(String(value), dec);
    return params.ticker ? s + ' ' + params.ticker : s;
  }
  if (format === 'addressName') return params.name ? params.name + ' (' + awsTrunc(String(value)) + ')' : String(value);
  if (format === 'date'){ const n = Number(value); return Number.isFinite(n) ? new Date(n*1000).toISOString() : String(value); }
  if (format === 'duration'){ const n = Number(value); return Number.isFinite(n) ? n + 's' : String(value); }
  return String(value);
}
function awsDescribeCall(ctx){
  const { signature, args } = ctx; const { name } = awsParseSignature(signature);
  const sym = ctx.symbol || 'tokens'; const dec = ctx.decimals != null ? ctx.decimals : 18;
  if (name === 'transfer' && args.length >= 2)
    return { title: 'Send ' + awsFormatAmount(String(args[1]), dec) + ' ' + sym + ' to ' + awsTrunc(String(args[0])),
             fields: [{label:'To', value:String(args[0])}, {label:'Amount', value: awsFormatAmount(String(args[1]),dec)+' '+sym}] };
  if (name === 'transferFrom' && args.length >= 3)
    return { title: 'Send ' + awsFormatAmount(String(args[2]), dec) + ' ' + sym + ' from ' + awsTrunc(String(args[0])) + ' to ' + awsTrunc(String(args[1])),
             fields: [{label:'From', value:String(args[0])}, {label:'To', value:String(args[1])}, {label:'Amount', value: awsFormatAmount(String(args[2]),dec)+' '+sym}] };
  if (name === 'approve' && args.length >= 2){
    const unlimited = awsIsUnlimited(String(args[1]));
    const amt = unlimited ? 'UNLIMITED ' + sym : awsFormatAmount(String(args[1]), dec) + ' ' + sym;
    return { title: 'Approve ' + awsTrunc(String(args[0])) + ' to spend ' + amt,
             fields: [{label:'Spender', value:String(args[0])}, {label:'Allowance', value: amt, danger: unlimited}] };
  }
  if (name === 'setApprovalForAll' && args.length >= 2 && (args[1] === true || args[1] === 'true'))
    return { title: 'Allow ' + awsTrunc(String(args[0])) + ' to transfer ALL your NFTs',
             fields: [{label:'Operator', value:String(args[0])}, {label:'Access', value:'ALL NFTs in this collection', danger:true}] };
  return null;
}
`;

// ── HTML builder ──────────────────────────────────────────────────────────────

export function buildHtml(req, port, networkUrl, opts = {}) {
  const autoTunnel = !!opts.autoTunnel;

  const CHAINS = {
    1:       { name: 'Ethereum',      explorer: 'https://etherscan.io',             rpc: 'https://eth.llamarpc.com',                       symbol: 'ETH'  },
    10:      { name: 'Optimism',      explorer: 'https://optimistic.etherscan.io',  rpc: 'https://mainnet.optimism.io',                    symbol: 'ETH'  },
    56:      { name: 'BNB Chain',     explorer: 'https://bscscan.com',              rpc: 'https://bsc-dataseed.binance.org',               symbol: 'BNB'  },
    100:     { name: 'Gnosis',        explorer: 'https://gnosisscan.io',            rpc: 'https://rpc.gnosischain.com',                    symbol: 'xDAI' },
    130:     { name: 'Unichain',      explorer: 'https://uniscan.xyz',              rpc: 'https://mainnet.unichain.org',                   symbol: 'ETH'  },
    137:     { name: 'Polygon',       explorer: 'https://polygonscan.com',          rpc: 'https://polygon-rpc.com',                       symbol: 'POL'  },
    480:     { name: 'World Chain',   explorer: 'https://worldscan.org',            rpc: 'https://worldchain-mainnet.g.alchemy.com/public', symbol: 'ETH' },
    5000:    { name: 'Mantle',        explorer: 'https://explorer.mantle.xyz',      rpc: 'https://rpc.mantle.xyz',                         symbol: 'MNT'  },
    8453:    { name: 'Base',          explorer: 'https://basescan.org',             rpc: 'https://mainnet.base.org',                       symbol: 'ETH'  },
    42161:   { name: 'Arbitrum One',  explorer: 'https://arbiscan.io',              rpc: 'https://arb1.arbitrum.io/rpc',                   symbol: 'ETH'  },
    42220:   { name: 'Celo',          explorer: 'https://celoscan.io',              rpc: 'https://forno.celo.org',                         symbol: 'CELO' },
    43114:   { name: 'Avalanche',     explorer: 'https://snowtrace.io',             rpc: 'https://api.avax.network/ext/bc/C/rpc',          symbol: 'AVAX' },
    81457:   { name: 'Blast',         explorer: 'https://blastscan.io',             rpc: 'https://rpc.blast.io',                           symbol: 'ETH'  },
    7777777: { name: 'Zora',          explorer: 'https://explorer.zora.energy',     rpc: 'https://rpc.zora.energy',                        symbol: 'ETH'  },
    // ── Testnets ──
    11155111:{ name: 'Sepolia',           explorer: 'https://sepolia.etherscan.io',          rpc: 'https://ethereum-sepolia-rpc.publicnode.com', symbol: 'ETH' },
    17000:   { name: 'Holesky',           explorer: 'https://holesky.etherscan.io',          rpc: 'https://ethereum-holesky-rpc.publicnode.com', symbol: 'ETH' },
    560048:  { name: 'Hoodi',             explorer: 'https://hoodi.etherscan.io',            rpc: 'https://ethereum-hoodi-rpc.publicnode.com',   symbol: 'ETH' },
    84532:   { name: 'Base Sepolia',      explorer: 'https://sepolia.basescan.org',          rpc: 'https://sepolia.base.org',                    symbol: 'ETH' },
    11155420:{ name: 'Optimism Sepolia',  explorer: 'https://sepolia-optimism.etherscan.io', rpc: 'https://sepolia.optimism.io',                 symbol: 'ETH' },
    421614:  { name: 'Arbitrum Sepolia',  explorer: 'https://sepolia.arbiscan.io',           rpc: 'https://sepolia-rollup.arbitrum.io/rpc',      symbol: 'ETH' },
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Review &amp; sign</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
           background: #0f1117; color: #e2e8f0; min-height: 100vh;
           display: flex; align-items: center; justify-content: center; padding: 1rem; }
    .card { background: #1a1d27; border: 1px solid #2d3148; border-radius: 12px;
            max-width: 480px; width: 100%; padding: 2rem; }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; color: #f1f5f9; }
    .desc { color: #94a3b8; font-size: 0.875rem; margin-bottom: 1.5rem; line-height: 1.5; }
    .summary { background: #12151e; border: 1px solid #2d3148; border-radius: 8px;
               padding: 1rem; margin-bottom: 1.5rem; font-size: 0.8125rem; }
    .row { display: flex; justify-content: space-between; gap: 1rem;
           padding: 0.25rem 0; border-bottom: 1px solid #1e2235; }
    .row:last-child { border-bottom: none; }
    .row-label { color: #64748b; flex-shrink: 0; }
    .row-value { color: #cbd5e1; word-break: break-all; text-align: right; }
    .decode { background: #0d1219; border: 1px solid #1e3a5f; border-radius: 8px;
              padding: 0.75rem 1rem; margin-bottom: 1.5rem; font-size: 0.8rem; display: none; }
    .decode-title { color: #60a5fa; font-weight: 500; margin-bottom: 0.5rem; }
    .decode-row { display: flex; gap: 1rem; padding: 0.15rem 0; }
    .decode-key { color: #64748b; min-width: 80px; flex-shrink: 0; }
    .decode-val { color: #93c5fd; word-break: break-all; }
    .copy-mini { width: auto; background: none; border: none; color: #64748b; cursor: pointer;
                 padding: 0 0 0 0.35rem; font-size: 0.8rem; vertical-align: baseline; }
    .copy-mini:hover { color: #60a5fa; opacity: 1; }
    button { width: 100%; padding: 0.75rem; border-radius: 8px; border: none;
             font-size: 0.9375rem; font-weight: 600; cursor: pointer;
             background: #3b82f6; color: #fff; transition: opacity 0.15s; }
    button:hover:not(:disabled) { opacity: 0.9; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .spinner { display: inline-block; width: 14px; height: 14px;
               border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff;
               border-radius: 50%; animation: spin 0.7s linear infinite;
               margin-right: 8px; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .alert { margin-top: 1.25rem; padding: 0.75rem 1rem; border-radius: 8px; font-size: 0.875rem; }
    .alert-success { background: #052e16; border: 1px solid #166534; color: #86efac; }
    .alert-error   { background: #2d0a0a; border: 1px solid #7f1d1d; color: #fca5a5; }
    .hash-link { color: #60a5fa; word-break: break-all; }
    .card-header { display: flex; justify-content: space-between; align-items: flex-start;
                   gap: 1rem; margin-bottom: 0.5rem; }
    .card-header h1 { margin-bottom: 0; }
    .raw-details { margin: 1rem 0 1.75rem; font-size: 0.8rem; }
    .raw-details summary { cursor: pointer; color: #64748b; user-select: none; }
    .raw-details summary:hover { color: #94a3b8; }
    .raw-details pre { margin-top: 0.5rem; background: #0d1219; border: 1px solid #1e2235;
                       border-radius: 8px; padding: 0.75rem; overflow-x: auto; color: #cbd5e1;
                       white-space: pre-wrap; word-break: break-all; }
    /* Small auto-width buttons override the full-width default */
    .icon-btn { width: auto; padding: 0.4rem 0.7rem; font-size: 0.75rem; font-weight: 500;
                background: #2d3148; color: #cbd5e1; border-radius: 6px; flex-shrink: 0;
                white-space: nowrap; }
    .icon-btn:hover:not(:disabled) { background: #3a3f5a; opacity: 1; }
    .row-value.copyable { cursor: pointer; transition: color 0.15s; }
    .row-value.copyable:hover { color: #60a5fa; }
    .row-value.copyable::after { content: ' ⧉'; color: #64748b; font-size: 0.75em; }
    .network-info { margin-top: 0.75rem; padding: 0.6rem 0.875rem; border-radius: 8px;
                    background: #0d1a2e; border: 1px solid #1e3a5f; font-size: 0.8rem;
                    color: #64748b; display: flex; align-items: center; gap: 0.5rem; }
    .network-info:first-of-type { margin-top: 1.25rem; }
    .network-info a { color: #60a5fa; text-decoration: none; word-break: break-all; flex: 1; }
    .network-info a:hover { text-decoration: underline; }
    .network-info.tunnel { background: #0d1e16; border-color: #1e5f3a; }
    .network-info.tunnel a { color: #4ade80; }
    .cross-device { margin-top: 1.25rem; }
    .net-caveat { margin-top: 0.5rem; padding: 0.5rem 0.75rem; border-radius: 8px;
                  background: #2a1e08; border: 1px solid #5f4a1e; color: #fbbf24;
                  font-size: 0.75rem; line-height: 1.4; }
    /* State visibility: sections with [data-show] are hidden unless body[data-state] matches */
    [data-show] { display: none; }
    body[data-state="ready"]       [data-show="ready"]     { display: block; }
    body[data-state="wrong-chain"] [data-show="ready"]     { display: block; }
    body[data-state="waiting"]     [data-show="ready"]     { display: block; }
    body[data-state="done"]        [data-show="done"]      { display: block; }
    body[data-state="error"]       [data-show="error"]     { display: block; }
    body[data-state="no-wallet"]   [data-show="no-wallet"] { display: block; }
  </style>
</head>
<body data-state="ready">
<div class="card">

  <div data-show="ready">
    <div class="card-header">
      <h1 id="headline">Review transaction</h1>
      <button class="icon-btn" id="copy-all-btn" title="Copy the raw transaction">⧉ Copy raw tx</button>
    </div>
    <div id="what" class="summary" style="display:none"></div>
    <details class="raw-details">
      <summary>Details</summary>
      <pre id="raw-tx"></pre>
    </details>
    <button id="btn">Connect Wallet</button>
  </div>

  <div data-show="waiting" style="display:none"></div>

  <div data-show="done">
    <h1>&#x2713; Done</h1>
    <p class="desc" style="margin-top:0.5rem">You can close this tab.</p>
    <div class="alert alert-success" id="done-msg"></div>
  </div>

  <div data-show="error">
    <h1>Something went wrong</h1>
    <div class="alert alert-error" id="error-msg" style="margin-top:1rem"></div>
    <button style="margin-top:1rem" id="retry-btn">Try again</button>
  </div>

  <div data-show="no-wallet">
    <h1>No Wallet Detected</h1>
    <p class="desc" style="margin-top:0.5rem">
      Install a browser wallet extension (MetaMask, Rabby, Coinbase Wallet, etc.) and reload this page.
    </p>
  </div>

  <div class="cross-device">
    <button class="icon-btn" id="cross-device-btn">📱 Sign on another device</button>
    <div id="cd-panel" style="display:none">
      <div class="network-info tunnel" id="cd-tunnel-row" style="display:none">
        <span>🌎 Open on your device:</span>
        <a id="cd-tunnel-link" href="#" target="_blank"></a>
        <button class="icon-btn" id="copy-tunnel-btn">⧉ Copy</button>
      </div>
      <button class="icon-btn" id="cd-check-btn" style="display:none">Check reachability</button>
      <div id="cd-status" class="net-caveat" style="display:none"></div>
      ${networkUrl ? `<div class="network-info">
        <span>📱 Same network:</span>
        <a href="${escHtml(networkUrl)}" target="_blank">${escHtml(networkUrl)}</a>
        <button class="icon-btn" id="copy-url-btn">⧉ Copy</button>
      </div>` : ''}
    </div>
  </div>

</div>
<script type="module">
// ── Injected by CLI ────────────────────────────────────────────────────────
const REQUEST    = ${JSON.stringify(req).replace(/<\/script>/gi, '<\\/script>')};
const RESULT_URL = '/result';
const AUTO_TUNNEL = ${autoTunnel};
const CHAIN_META = ${JSON.stringify(CHAINS).replace(/<\/script>/gi, '<\\/script>')};

// ── Pure decode helpers (shared with node tests) ────────────────────────────
${DECODE_HELPERS_JS}

// ── Helpers ────────────────────────────────────────────────────────────────
const setState = s => { document.body.dataset.state = s; };
const hex = n  => '0x' + n.toString(16);

// Copy text to clipboard, with a fallback for insecure (plain http/LAN) contexts
// where navigator.clipboard is unavailable. Flashes "✓ Copied" on the button.
async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
  }
  if (btn) {
    const orig = btn.textContent;
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = orig; }, 1200);
  }
}

// Format a wei value (hex string) as a decimal ETH amount, trimming trailing zeros.
function formatEther(weiHex) {
  const wei = BigInt(weiHex || '0x0');
  const ONE = 1000000000000000000n;
  const whole = wei / ONE;
  const frac = wei % ONE;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '');
  return whole.toString() + '.' + fracStr;
}

// Human-readable JSON of the full request, for the "Copy all" button.
function txDataText() {
  const meta = CHAIN_META[REQUEST.chainId] || {};
  const out = { chainId: REQUEST.chainId, chain: meta.name || \`Chain \${REQUEST.chainId}\` };
  if (REQUEST._type === 'sendTransaction') {
    if (REQUEST.to) out.to = REQUEST.to;
    out.value = REQUEST.value || '0x0';
    out.valueEth = formatEther(REQUEST.value) + ' ' + (meta.symbol || 'ETH');
    if (REQUEST.data) out.data = REQUEST.data;
    if (REQUEST.gas) out.gas = REQUEST.gas;
  } else if (REQUEST._type === 'signTypedData') {
    out.typedData = REQUEST.typedData;
  } else {
    out.message = REQUEST.message;
  }
  return JSON.stringify(out, null, 2);
}

// ── Summary table ──────────────────────────────────────────────────────────
// ── Post result back to CLI ────────────────────────────────────────────────
async function postResult(data) {
  await fetch(RESULT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
}

// ── Signing logic (implemented in Task 6) ─────────────────────────────────
function showError(msg) {
  setState('error');
  document.getElementById('error-msg').textContent = msg;
}

async function onConnect() {
  const btn = document.getElementById('btn');
  btn.disabled = true;
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const account = accounts[0];
    const currentChainHex = await window.ethereum.request({ method: 'eth_chainId' });
    if (Number(currentChainHex) !== REQUEST.chainId) {
      // Trigger the network switch automatically — no extra button click.
      // The wallet still shows its own approval prompt for the switch.
      await switchChain(account);
      return;
    }
    await sign(account);
  } catch (e) {
    showError(e.message || String(e));
  }
}

async function switchChain(account) {
  const btn = document.getElementById('btn');
  const chainName = (CHAIN_META[REQUEST.chainId] || {}).name || 'the required network';
  btn.disabled = true;
  btn.innerHTML = \`<span class="spinner"></span>Switch to \${chainName} in your wallet…\`;
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hex(REQUEST.chainId) }],
    });
  } catch (err) {
    if (err.code === 4902) {
      const meta = CHAIN_META[REQUEST.chainId];
      if (!meta?.rpc) { showError('Unknown chain — add it manually in your wallet.'); return; }
      try {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: hex(REQUEST.chainId),
            chainName: meta.name,
            nativeCurrency: { name: meta.symbol, symbol: meta.symbol, decimals: 18 },
            rpcUrls: [meta.rpc],
            blockExplorerUrls: meta.explorer ? [meta.explorer] : [],
          }],
        });
      } catch (addErr) {
        showError(addErr.message || 'Failed to add chain');
        return;
      }
    } else {
      showError(err.message || 'Chain switch failed');
      return;
    }
  }
  await sign(account);
}

async function buildTx(account) {
  const tx = {
    type: '0x2',
    from: account,
    chainId: hex(REQUEST.chainId),
    value: REQUEST.value || '0x0',
  };
  if (REQUEST.to)   tx.to   = REQUEST.to;
  if (REQUEST.data) tx.data = REQUEST.data;

  // Gas limit
  if (REQUEST.gas) {
    tx.gas = REQUEST.gas;
  } else {
    const est = await window.ethereum.request({ method: 'eth_estimateGas', params: [tx] });
    tx.gas = hex(Math.ceil(Number(est) * 1.2));
  }

  // EIP-1559 fees
  if (REQUEST.maxFeePerGas && REQUEST.maxPriorityFeePerGas) {
    tx.maxFeePerGas = REQUEST.maxFeePerGas;
    tx.maxPriorityFeePerGas = REQUEST.maxPriorityFeePerGas;
  } else {
    // Best-effort fee estimation. Some wallets/RPCs don't expose
    // eth_maxPriorityFeePerGas — fall back gracefully, and if we can't
    // estimate at all, omit fee fields entirely so the wallet fills them in.
    try {
      const block = await window.ethereum.request({
        method: 'eth_getBlockByNumber', params: ['latest', false],
      });
      const baseFee = BigInt(block.baseFeePerGas);

      let priorityFee;
      try {
        priorityFee = BigInt(await window.ethereum.request({ method: 'eth_maxPriorityFeePerGas' }));
      } catch {
        priorityFee = 1500000000n; // 1.5 gwei default tip
      }

      tx.maxPriorityFeePerGas = hex(priorityFee);
      tx.maxFeePerGas         = hex(baseFee * 2n + priorityFee);
    } catch {
      // Couldn't estimate — let the wallet populate gas fees on its own.
    }
  }
  return tx;
}

async function sign(account) {
  const btn = document.getElementById('btn');
  setState('waiting');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Check your wallet…';

  try {
    let result;
    if (REQUEST._type === 'signTypedData') {
      const sig = await window.ethereum.request({
        method: 'eth_signTypedData_v4',
        params: [account, JSON.stringify(REQUEST.typedData)],
      });
      result = { signature: sig, chainId: REQUEST.chainId };

    } else if (REQUEST._type === 'personalSign') {
      const msgHex = '0x' + Array.from(new TextEncoder().encode(REQUEST.message))
        .map(b => b.toString(16).padStart(2, '0')).join('');
      const sig = await window.ethereum.request({
        method: 'personal_sign',
        params: [msgHex, account],
      });
      result = { signature: sig, chainId: REQUEST.chainId };

    } else {
      const tx   = await buildTx(account);
      const hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [tx] });
      result = { hash, chainId: REQUEST.chainId };
    }

    await postResult(result);
    setState('done');

    const doneMsg = document.getElementById('done-msg');
    if (result.hash) {
      const meta        = CHAIN_META[REQUEST.chainId];
      const explorerUrl = meta?.explorer ? \`\${meta.explorer}/tx/\${result.hash}\` : null;
      doneMsg.innerHTML = explorerUrl
        ? \`Transaction: <a class="hash-link" href="\${explorerUrl}" target="_blank">\${result.hash}</a>\`
        : \`Transaction: \${result.hash}\`;
    } else {
      doneMsg.textContent = \`Signature: \${result.signature}\`;
    }

    // Best-effort auto-close. Browsers only let a script close a tab it opened
    // itself, so this silently no-ops for OS-launched tabs — the "you can close
    // this tab" fallback message stays visible in that case.
    setTimeout(() => { try { window.close(); } catch {} }, 1500);

  } catch (e) {
    showError(e.message || String(e));
  }
}

// ── Calldata decoding (implemented in Task 7) ─────────────────────────────

// Manual ABI decoder for fixed-size slot types.
// Covers the most common parameter types (address, uint*, bool, bytes32).
// Dynamic types (string, bytes[], tuples) fall back to "(complex type)".
// ── "What this does": decode the transaction from its own data ──────────────
// Layered & best-effort: ERC-7730 descriptor → resolved-signature semantic
// render (4byte/openchain + viem) → generic decoded call → raw. Any failure
// falls through; signing is never blocked. The wallet's own review is the
// final backstop.
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// Single combined section: headline (the plain-English action) on top, then one
// detail table — Chain once, recipient once (copyable), amount once, danger
// flags, and gas if explicitly provided. No duplicated rows.
function showWhat(title, fields) {
  if (title) document.getElementById('headline').textContent = title;
  const meta = CHAIN_META[REQUEST.chainId] || {};
  const rows = [{ label: 'Chain', value: meta.name || ('Chain ' + REQUEST.chainId) }, ...fields];
  if (REQUEST._type === 'sendTransaction' && REQUEST.gas)
    rows.push({ label: 'Gas limit', value: Number(BigInt(REQUEST.gas)).toLocaleString() });
  const isAddr = v => /^0x[0-9a-fA-F]{40}$/.test(String(v));
  const el = document.getElementById('what');
  el.style.display = 'block';
  el.innerHTML = rows.map(f => {
    const addr = isAddr(f.value);
    const copyBtn = addr ? ' <button class="copy-mini" data-copy="' + esc(String(f.value)) + '" title="Copy address">⧉</button>' : '';
    return '<div class="decode-row"><span class="decode-key">' + esc(f.label) + '</span>' +
           '<span class="decode-val"' + (f.danger ? ' style="color:#fca5a5"' : '') + '>' +
           esc(String(f.value)) + copyBtn + '</span></div>';
  }).join('');
  el.querySelectorAll('.copy-mini').forEach(b => b.addEventListener('click', () => copyText(b.dataset.copy, b)));
}

async function resolveSignature(selector) {
  try {
    const { loaders } = await import('https://esm.sh/@shazow/whatsabi');
    const lookup = new loaders.OpenChainSignatureLookup();
    const sigs = await lookup.loadFunctions(selector);
    return (sigs || []).map(s => typeof s === 'string' ? s : (s.name || String(s)));
  } catch { return []; }
}

async function decodeArgs(signature, data) {
  const { parseAbiItem, decodeFunctionData } = await import('https://esm.sh/viem');
  const abi = [ parseAbiItem('function ' + signature) ];
  const { args } = decodeFunctionData({ abi, data });
  return (args || []).map(a => typeof a === 'bigint' ? a.toString() : a);
}

async function tokenMeta(addr) {
  try {
    const { decodeAbiParameters } = await import('https://esm.sh/viem');
    const symHex = await window.ethereum.request({ method: 'eth_call', params: [{ to: addr, data: '0x95d89b41' }, 'latest'] });
    const decHex = await window.ethereum.request({ method: 'eth_call', params: [{ to: addr, data: '0x313ce567' }, 'latest'] });
    let symbol = null, decimals = 18;
    try { symbol = decodeAbiParameters([{ type: 'string' }], symHex)[0]; } catch {}
    try { decimals = Number(decodeAbiParameters([{ type: 'uint8' }], decHex)[0]); } catch {}
    return { symbol, decimals };
  } catch { return { symbol: null, decimals: 18 }; }
}

function resolvePath(args, path) {
  if (path == null) return '';
  let key = String(path);
  if (key[0] === '#') key = key.slice(1);
  if (key[0] === '.') key = key.slice(1);
  if (args && typeof args === 'object' && !Array.isArray(args) && key in args) return args[key];
  const n = Number(key);
  if (Number.isInteger(n) && Array.isArray(args)) return args[n];
  return Array.isArray(args) ? args.join(', ') : String(args);
}

function findDescriptorPath(idx, chainId, to) {
  // The 'to' arg is lowercased by the caller. Registry index keys are often
  // EIP-55 checksummed, so match addresses case-insensitively.
  try {
    if (Array.isArray(idx)) {
      const hit = idx.find(e => String(e.chainId) === String(chainId) && (e.address || '').toLowerCase() === to);
      return (hit && (hit.path || hit.file)) || null;
    }
    const byChain = idx[String(chainId)] || idx[chainId] || idx;
    if (byChain && typeof byChain === 'object') {
      for (const [k, v] of Object.entries(byChain)) {
        if (k.toLowerCase() === to) return (v && (v.path || v.file)) || v || null;
      }
    }
  } catch {}
  return null;
}

async function tryCalldataDescriptor(chainId, addr, data) {
  try {
    const idx = await (await fetch(awsDescriptorIndexUrl('calldata'))).json();
    const path = findDescriptorPath(idx, chainId, String(addr).toLowerCase());
    if (!path) return null;
    const base = 'https://raw.githubusercontent.com/ethereum/clear-signing-erc7730-registry/master/registry/';
    const descriptor = await (await fetch(base + path)).json();
    const { decodeFunctionData } = await import('https://esm.sh/viem');
    const abi = descriptor.context && descriptor.context.contract && descriptor.context.contract.abi;
    if (!abi || !data) return null;
    const { functionName, args } = decodeFunctionData({ abi, data });
    const formats = (descriptor.display && descriptor.display.formats) || {};
    const fmt = formats[functionName] || formats[data.slice(0, 10)];
    if (!fmt) return null;
    const fields = (fmt.fields || []).map(f => ({
      label: f.label || f.path,
      value: awsFormatDescriptorField(f.format, resolvePath(args, f.path), f.params || {}),
    }));
    return { title: fmt.intent || functionName, fields };
  } catch { return null; }
}

async function renderWhatThisDoes() {
  document.getElementById('headline').textContent = awsPlaceholderTitle(REQUEST._type);

  if (REQUEST._type === 'personalSign') {
    showWhat('Sign message', [{ label: 'Message', value: REQUEST.message }]);
    return;
  }
  if (REQUEST._type === 'signTypedData') {
    const td = REQUEST.typedData || {};
    const rows = Object.entries(td.message || {}).map(([k, v]) =>
      ({ label: k, value: typeof v === 'object' ? JSON.stringify(v) : String(v) }));
    showWhat('Sign ' + (td.primaryType || 'typed data'),
      rows.length ? rows : [{ label: 'Type', value: td.primaryType || '(unknown)' }]);
    return;
  }

  const { to, data, value } = REQUEST;

  // Contract deployment
  if (!to && data && data.length > 2) {
    const bytes = Math.floor((data.length - 2) / 2);
    showWhat('Deploy a new contract', [{ label: 'Bytecode', value: bytes + ' bytes' }]);
    return;
  }

  // Native send (no calldata)
  if (!data || data.length < 10) {
    const sym = (CHAIN_META[REQUEST.chainId] || {}).symbol || 'ETH';
    const amt = awsFormatAmount(BigInt(value || '0x0').toString(), 18) + ' ' + sym;
    if (to) showWhat('Send ' + amt + ' to ' + awsTrunc(to), [{ label: 'To', value: to }, { label: 'Amount', value: amt }]);
    return;
  }

  // 1) ERC-7730 descriptor (protocol-authored)
  const desc7730 = await tryCalldataDescriptor(REQUEST.chainId, to, data);
  if (desc7730) { showWhat(desc7730.title, desc7730.fields); return; }

  // 2) Resolved-signature semantic render
  const sigs = await resolveSignature(data.slice(0, 10));
  if (!sigs.length) {
    showWhat(null, [{ label: 'Call', value: 'Unknown function ' + data.slice(0, 10) + ' — confirm in your wallet' }]);
    return;
  }
  const signature = sigs[0];
  let args;
  try { args = await decodeArgs(signature, data); }
  catch {
    showWhat('Calls ' + awsParseSignature(signature).name + '()',
      [{ label: 'Signature', value: signature }, { label: 'Note', value: 'Could not decode arguments — confirm in your wallet' }]);
    return;
  }

  const { name, types } = awsParseSignature(signature);
  let meta = {};
  if ((name === 'transfer' || name === 'transferFrom' || name === 'approve') && to) meta = await tokenMeta(to);
  const desc = awsDescribeCall({ signature, args, symbol: meta.symbol, decimals: meta.decimals });
  if (desc) { showWhat(desc.title, desc.fields); return; }

  // 3) Generic decoded call
  showWhat('Calls ' + name + '()', types.map((t, i) => ({ label: t, value: String(args[i] != null ? args[i] : '?') })));
}

// ── Cross-device tunnel + copy buttons (work regardless of wallet state) ─────
function showTunnel(url) {
  document.getElementById('cd-tunnel-link').href = url;
  document.getElementById('cd-tunnel-link').textContent = url;
  document.getElementById('cd-tunnel-row').style.display = 'flex';
  document.getElementById('cd-check-btn').style.display = 'block';
}
function showStatus(msg) {
  const el = document.getElementById('cd-status');
  el.textContent = msg;
  el.style.display = 'block';
}
async function startTunnel() {
  const btn = document.getElementById('cross-device-btn');
  document.getElementById('cd-panel').style.display = 'block';
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Starting secure tunnel…';
  try {
    const res = await fetch('/tunnel/start', { method: 'POST' }).then(r => r.json());
    if (res.url) {
      showTunnel(res.url);
      btn.style.display = 'none';
    } else {
      showStatus('Could not start a tunnel right now (Cloudflare may be throttled). Use the same-network address below, or try again later.');
      btn.disabled = false;
      btn.textContent = '📱 Sign on another device';
    }
  } catch {
    showStatus('Tunnel request failed. Try again.');
    btn.disabled = false;
    btn.textContent = '📱 Sign on another device';
  }
}
async function checkTunnel() {
  const btn = document.getElementById('cd-check-btn');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span>Checking…';
  const { reachable } = await fetch('/tunnel/check', { method: 'POST' }).then(r => r.json());
  btn.disabled = false;
  btn.textContent = orig;
  showStatus(reachable
    ? '✓ Tunnel is reachable — open the link on your other device.'
    : '⚠ Not reachable yet (DNS may still be propagating, or Cloudflare is throttling). Wait a few seconds and check again.');
}
const cdBtn = document.getElementById('cross-device-btn');
if (cdBtn) cdBtn.addEventListener('click', startTunnel);
const cdCheck = document.getElementById('cd-check-btn');
if (cdCheck) cdCheck.addEventListener('click', checkTunnel);
const copyTunnelBtn = document.getElementById('copy-tunnel-btn');
if (copyTunnelBtn) copyTunnelBtn.addEventListener('click', e =>
  copyText(document.getElementById('cd-tunnel-link').href, e.currentTarget));
const copyUrlBtn = document.getElementById('copy-url-btn');
if (copyUrlBtn) copyUrlBtn.addEventListener('click', e =>
  copyText(e.currentTarget.closest('.network-info').querySelector('a').getAttribute('href'), e.currentTarget));
const copyAllBtn = document.getElementById('copy-all-btn');
if (copyAllBtn) copyAllBtn.addEventListener('click', e => copyText(txDataText(), e.currentTarget));
if (AUTO_TUNNEL) startTunnel();

// ── Init ───────────────────────────────────────────────────────────────────
if (!window.ethereum) {
  setState('no-wallet');
} else {
  renderWhatThisDoes().catch(() => {});
  document.getElementById('raw-tx').textContent = txDataText();
  document.getElementById('btn').addEventListener('click', onConnect);
  document.getElementById('retry-btn').addEventListener('click', () => {
    setState('ready');
    document.getElementById('btn').disabled = false;
    document.getElementById('btn').textContent = 'Connect Wallet';
    document.getElementById('btn').onclick = onConnect;
  });
}
</script>
</body>
</html>`;
}

// HTML-escape helper (used by the full template in Task 5)
export function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Main orchestration ────────────────────────────────────────────────────────

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const PREFERRED_PORT = 8456; // stable port enables cloudflared tunnel reuse across runs

export const HELP_TEXT = `request-wallet-sign — surface a wallet signing request to a user via a browser page

USAGE
  npx request-wallet-sign [--tunnel] '<request JSON>'
  npx request-wallet-sign --stop-tunnel

OPTIONS
  --tunnel       Pre-start the cross-device HTTPS tunnel as soon as the page
                 loads. Otherwise the tunnel starts when you click "Sign on
                 another device" in the page. Cross-device signing needs this
                 HTTPS tunnel because mobile wallets only inject a provider
                 over HTTPS — a plain http://LAN-IP address will not work.
  --stop-tunnel  Tear down the shared background cloudflared tunnel and exit.
  --help, -h     Show this help.

The request JSON is a single argument. Operation type is inferred:
  typedData → eth_signTypedData_v4 · message → personal_sign · otherwise → eth_sendTransaction

Cross-device tunnels are REUSED across invocations (recorded in
~/.request-wallet-sign/state.json) so signing many transactions does not create
many tunnels. The shared tunnel is one background process, reaped after 10
minutes idle or immediately with --stop-tunnel.

On success prints {"hash"|"signature", "chainId"} to stdout and exits 0.
On rejection / no wallet / 5-min timeout prints to stderr and exits 1.
`;

export async function run(argv) {
  if (argv.slice(2).some(a => a === '--help' || a === '-h')) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  const opts = parseOptions(argv);

  if (opts.stopTunnel) {
    const url = stopTunnel();
    process.stderr.write(url ? `stopped tunnel ${url}\n` : 'no tunnel was running\n');
    process.exit(0);
  }

  let req;
  try {
    req = parseRequest(argv);
  } catch (e) {
    process.stderr.write(e.message + '\n');
    process.exit(1);
  }

  const port = await choosePort(PREFERRED_PORT);
  const networkIP = getLocalNetworkIP();
  const networkUrl = networkIP ? `http://${networkIP}:${port}` : null;

  const tunnel = createTunnelController(port, { log: m => process.stderr.write(`tunnel: ${m}\n`) });
  const html = buildHtml(req, port, networkUrl, { autoTunnel: opts.tunnel });
  const { result, close } = startServer(port, html, tunnel);

  const timeout = setTimeout(() => {
    close();
    process.stderr.write('timeout: user did not respond\n');
    process.exit(1);
  }, TIMEOUT_MS);

  if (networkUrl) process.stderr.write(`same-network URL: ${networkUrl}\n`);
  process.stderr.write('cross-device: use the "Sign on another device" button in the page\n');
  openBrowser(`http://localhost:${port}`);

  result
    .then(data => {
      clearTimeout(timeout);
      close(); // NOTE: do NOT kill the tunnel — it persists for reuse
      process.stdout.write(JSON.stringify(data) + '\n');
      process.exit(0);
    })
    .catch(e => {
      clearTimeout(timeout);
      close();
      process.stderr.write((e.message ?? String(e)) + '\n');
      process.exit(1);
    });
}

// ── Entry point ───────────────────────────────────────────────────────────────
// Only execute when run directly (not when imported by tests). Resolve symlinks
// on both sides: when launched via an installed bin (npx / global install),
// process.argv[1] is a symlink in node_modules/.bin whose realpath is this file,
// while import.meta.url is already the resolved path — comparing them raw fails.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let isMain = false;
try {
  isMain = !!process.argv[1] &&
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch { isMain = false; }

if (isMain) {
  run(process.argv);
}
