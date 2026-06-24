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
    throw new Error("Usage: agent-wallet-signer [--tunnel] '<request JSON>'");
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

  // Default value for sendTransaction
  if (_type === 'sendTransaction' && req.value === undefined) {
    req.value = '0x0';
  }

  return req;
}

// ── Port finding ──────────────────────────────────────────────────────────────

import { createServer as createNetServer } from 'node:net';
import { networkInterfaces, homedir } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

function stateDir() {
  return process.env.AGENT_WALLET_SIGNER_HOME || join(homedir(), '.agent-wallet-signer');
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

export function startServer(port, html) {
  let resolveResult, rejectResult;
  const result = new Promise((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });

  const server = createHttpServer((req, res) => {
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

// Spawn a DETACHED cloudflared quick tunnel that survives CLI exit (for reuse).
// Resolves { url, pid } once the URL is printed, or null on failure/timeout.
function startCloudflared(port) {
  return new Promise(resolve => {
    const proc = spawn('npx', ['-y', 'cloudflared', 'tunnel', '--url', `http://127.0.0.1:${port}`],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', settled = false;
    const finish = url => {
      if (settled) return;
      settled = true;
      if (url) { proc.unref(); resolve({ url, pid: proc.pid }); }
      else { try { proc.kill(); } catch {} resolve(null); }
    };
    const onData = c => { buf += c.toString(); const u = extractTunnelUrl(buf); if (u) finish(u); };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', () => finish(null));
    proc.on('error', () => finish(null));
    setTimeout(() => finish(null), 25000);
  });
}

async function probeUrl(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return r.status === 200;
  } catch { return false; }
}

// ── HTML builder ──────────────────────────────────────────────────────────────

export function buildHtml(req, port, networkUrl, tunnelUrl, tunnelThrottled) {
  const label = req.label || 'Sign Transaction';
  const description = req.description || '';

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

  // Connectivity banner: a live tunnel takes over entirely; otherwise show the
  // LAN address (with a caveat if a requested tunnel was throttled/unconfirmed).
  let connectivityHtml = '';
  if (tunnelUrl) {
    connectivityHtml = `<div class="network-info tunnel">
    <span>&#x1f30e; Sign on any device:</span>
    <a href="${escHtml(tunnelUrl)}" target="_blank">${escHtml(tunnelUrl)}</a>
    <button class="icon-btn" id="copy-tunnel-btn" title="Copy public HTTPS URL">⧉ Copy</button>
  </div>`;
  } else if (networkUrl) {
    const caveat = tunnelThrottled
      ? `<div class="net-caveat">&#x26a0;&#xfe0f; The Cloudflare tunnel is currently throttled, so cross-device signing over HTTPS is unavailable right now. This same-network address works for devices on this Wi-Fi; re-run with <code>--tunnel</code> later to sign from anywhere.</div>`
      : '';
    connectivityHtml = `<div class="network-info">
    <span>&#x1f4f1; Same network:</span>
    <a href="${escHtml(networkUrl)}" target="_blank">${escHtml(networkUrl)}</a>
    <button class="icon-btn" id="copy-url-btn" title="Copy network URL">⧉ Copy</button>
  </div>${caveat}`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escHtml(label)}</title>
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
      <h1>${escHtml(label)}</h1>
      <button class="icon-btn" id="copy-all-btn" title="Copy full transaction data">⧉ Copy all</button>
    </div>
    ${description ? `<p class="desc">${escHtml(description)}</p>` : ''}
    <div class="summary" id="summary"></div>
    <div class="decode" id="decode"></div>
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

  ${connectivityHtml}

</div>
<script type="module">
// ── Injected by CLI ────────────────────────────────────────────────────────
const REQUEST    = ${JSON.stringify(req).replace(/<\/script>/gi, '<\\/script>')};
const RESULT_URL = '/result';
const CHAIN_META = ${JSON.stringify(CHAINS).replace(/<\/script>/gi, '<\\/script>')};

// ── Helpers ────────────────────────────────────────────────────────────────
const setState = s => { document.body.dataset.state = s; };
const hex = n  => '0x' + n.toString(16);
const trunc = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '—';

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
function renderSummary() {
  const meta = CHAIN_META[REQUEST.chainId] || {};
  const chainName = meta.name || \`Chain \${REQUEST.chainId}\`;
  const symbol = meta.symbol || 'ETH';
  const rows = [{ label: 'Chain', value: chainName }];
  if (REQUEST._type === 'sendTransaction') {
    if (REQUEST.to) {
      rows.push({ label: 'To', value: trunc(REQUEST.to), copy: REQUEST.to });
    } else {
      rows.push({ label: 'To', value: 'Contract deployment' });
    }
    const val = BigInt(REQUEST.value || '0x0');
    if (val > 0n) rows.push({ label: 'Value', value: \`\${formatEther(REQUEST.value)} \${symbol}\` });
    if (REQUEST.gas) rows.push({ label: 'Gas limit', value: Number(BigInt(REQUEST.gas)).toLocaleString() });
  } else if (REQUEST._type === 'signTypedData') {
    rows.push({ label: 'Type', value: REQUEST.typedData?.primaryType || '—' });
  } else {
    rows.push({ label: 'Type', value: 'personal_sign' });
  }
  document.getElementById('summary').innerHTML = rows
    .map(r => \`<div class="row"><span class="row-label">\${r.label}</span>\` +
      (r.copy
        ? \`<span class="row-value copyable" data-copy="\${r.copy}" title="Click to copy">\${r.value}</span>\`
        : \`<span class="row-value">\${r.value}</span>\`) +
      \`</div>\`)
    .join('');
  document.querySelectorAll('#summary .copyable').forEach(el => {
    el.addEventListener('click', () => copyText(el.dataset.copy, null));
  });
}

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
function decodeSlot(type, slot) {
  if (type === 'address')                  return '0x' + slot.slice(-40);
  if (/^u?int(\d+)?$/.test(type)) {
    try { return BigInt('0x' + slot).toString(); } catch { return '0x' + slot; }
  }
  if (type === 'bool')                     return slot.endsWith('1') ? 'true' : 'false';
  if (/^bytes(\d+)?$/.test(type))         return '0x' + slot;
  return '(complex type)';
}

function decodeCalldata(hexData, sig) {
  const match = sig.match(/^\w+\((.*)\)$/);
  if (!match) return null;
  const types = match[1].split(',').map(t => t.trim()).filter(Boolean);
  if (types.length === 0) return { params: [] };
  const payload = hexData.slice(10); // strip 0x + 4-byte selector
  return {
    params: types.map((type, i) => {
      const slot = payload.slice(i * 64, i * 64 + 64);
      return { type, value: slot && slot.length === 64 ? decodeSlot(type, slot) : '?' };
    }),
  };
}

async function initDecoding() {
  const decodeEl = document.getElementById('decode');
  if (!decodeEl) return;

  const { data, to } = REQUEST;

  // Contract deployment — no 'to', just show bytecode size
  if (!to && data && data.length > 2) {
    const bytes = Math.floor((data.length - 2) / 2);
    decodeEl.style.display = 'block';
    decodeEl.innerHTML = \`<div class="decode-title">Contract deployment</div>
      <div class="decode-row">
        <span class="decode-key">Bytecode</span>
        <span class="decode-val">\${bytes} bytes</span>
      </div>\`;
    return;
  }

  // Need at least a 4-byte selector (0x + 8 hex chars = 10 chars total)
  if (!data || data.length < 10) return;

  const selector = data.slice(2, 10); // 8 hex chars, no 0x prefix

  try {
    const { loaders } = await import('https://esm.sh/@shazow/whatsabi');
    const sigLoader = new loaders.SigHashLoader();
    const fns = await sigLoader.loadFunctions(selector);

    if (!fns || fns.length === 0) {
      decodeEl.style.display = 'block';
      decodeEl.innerHTML = \`<div class="decode-title">Unknown function</div>
        <div class="decode-row">
          <span class="decode-key">Selector</span>
          <span class="decode-val">0x\${selector}</span>
        </div>\`;
      return;
    }

    // fns[0] may be a string like "transfer(address,uint256)" or an object with a name property
    const sig = typeof fns[0] === 'string' ? fns[0] : (fns[0].name || JSON.stringify(fns[0]));
    const safeSig = sig.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const decoded = decodeCalldata(data, sig);

    decodeEl.style.display = 'block';
    let inner = \`<div class="decode-title">Calling: \${safeSig}</div>\`;
    if (decoded?.params.length) {
      inner += decoded.params
        .map(p => \`<div class="decode-row">
          <span class="decode-key">\${p.type}</span>
          <span class="decode-val">\${p.value}</span>
        </div>\`)
        .join('');
    }
    decodeEl.innerHTML = inner;

  } catch {
    // whatsabi CDN unavailable or lookup failed — skip decoding silently
  }
}

// ── Copy buttons (work regardless of wallet state) ──────────────────────────
function wireCopyUrl(btnId) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  const url = btn.closest('.network-info').querySelector('a').getAttribute('href');
  btn.addEventListener('click', e => copyText(url, e.currentTarget));
}
wireCopyUrl('copy-tunnel-btn');
wireCopyUrl('copy-url-btn');
const copyAllBtn = document.getElementById('copy-all-btn');
if (copyAllBtn) {
  copyAllBtn.addEventListener('click', e => copyText(txDataText(), e.currentTarget));
}

// ── Init ───────────────────────────────────────────────────────────────────
if (!window.ethereum) {
  setState('no-wallet');
} else {
  renderSummary();
  initDecoding();
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

export const HELP_TEXT = `agent-wallet-signer — surface a wallet signing request to a user via a browser page

USAGE
  npx agent-wallet-signer [--tunnel] '<request JSON>'

OPTIONS
  --tunnel    Expose the signing page over a public HTTPS URL (Cloudflare quick
              tunnel, auto-installed via npx — no account needed).
              ► REQUIRED to sign on ANOTHER DEVICE (phone, tablet, other computer).
              Mobile wallet browsers only inject a provider over HTTPS, so the
              default http://localhost / http://LAN-IP address will NOT work on
              another device. Without this flag the page is local-only.
  --help, -h  Show this help.

The request JSON is a single argument. Operation type is inferred:
  typedData → eth_signTypedData_v4 · message → personal_sign · otherwise → eth_sendTransaction

On success prints {"hash"|"signature", "chainId"} to stdout and exits 0.
On rejection / no wallet / 5-min timeout prints to stderr and exits 1.
`;

export async function run(argv) {
  if (argv.slice(2).some(a => a === '--help' || a === '-h')) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  let req, opts;
  try {
    req = parseRequest(argv);
    opts = parseOptions(argv);
  } catch (e) {
    process.stderr.write(e.message + '\n');
    process.exit(1);
  }

  const port = await findAvailablePort();
  const networkIP = getLocalNetworkIP();
  const networkUrl = networkIP ? `http://${networkIP}:${port}` : null;

  const html = buildHtml(req, port, networkUrl);
  const { result, close } = startServer(port, html);
  const cleanup = () => { close(); };

  const timeout = setTimeout(() => {
    cleanup();
    process.stderr.write('timeout: user did not respond\n');
    process.exit(1);
  }, TIMEOUT_MS);

  if (networkUrl) process.stderr.write(`same-network URL: ${networkUrl}\n`);
  openBrowser(`http://localhost:${port}`);

  result
    .then(data => {
      clearTimeout(timeout);
      cleanup();
      process.stdout.write(JSON.stringify(data) + '\n');
      process.exit(0);
    })
    .catch(e => {
      clearTimeout(timeout);
      cleanup();
      process.stderr.write((e.message ?? String(e)) + '\n');
      process.exit(1);
    });
}

// ── Entry point ───────────────────────────────────────────────────────────────
// Only execute when run directly (not when imported by tests).

const isMain = process.argv[1] &&
  new URL(import.meta.url).pathname === process.argv[1];

if (isMain) {
  run(process.argv);
}
