#!/usr/bin/env node

// ── Request parsing ───────────────────────────────────────────────────────────

export function parseRequest(argv) {
  const raw = argv[2];
  if (!raw) {
    throw new Error("Usage: agent-wallet-signer '<request JSON>'");
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

export function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
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

  server.listen(port, '127.0.0.1');
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

// ── HTML builder ──────────────────────────────────────────────────────────────

export function buildHtml(req, port) {
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
  };

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
    <h1>${escHtml(label)}</h1>
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

</div>
<script type="module">
// ── Injected by CLI ────────────────────────────────────────────────────────
const REQUEST    = ${JSON.stringify(req).replace(/<\/script>/gi, '<\\/script>')};
const RESULT_URL = 'http://localhost:${port}/result';
const CHAIN_META = ${JSON.stringify(CHAINS).replace(/<\/script>/gi, '<\\/script>')};

// ── Helpers ────────────────────────────────────────────────────────────────
const setState = s => { document.body.dataset.state = s; };
const hex = n  => '0x' + n.toString(16);
const trunc = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '—';

// ── Summary table ──────────────────────────────────────────────────────────
function renderSummary() {
  const chainName = (CHAIN_META[REQUEST.chainId] || {}).name || \`Chain \${REQUEST.chainId}\`;
  const rows = [['Chain', chainName]];
  if (REQUEST._type === 'sendTransaction') {
    rows.push(['To', REQUEST.to ? trunc(REQUEST.to) : 'Contract deployment']);
    const val = BigInt(REQUEST.value || '0x0');
    if (val > 0n) rows.push(['Value', \`\${val} wei\`]);
    if (REQUEST.gas) rows.push(['Gas limit', parseInt(REQUEST.gas, 16).toLocaleString()]);
  } else if (REQUEST._type === 'signTypedData') {
    rows.push(['Type', REQUEST.typedData?.primaryType || '—']);
  } else {
    rows.push(['Type', 'personal_sign']);
  }
  document.getElementById('summary').innerHTML = rows
    .map(([k, v]) => \`<div class="row"><span class="row-label">\${k}</span><span class="row-value">\${v}</span></div>\`)
    .join('');
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
async function onConnect() { /* replaced in Task 6 */ }

// ── Calldata decoding (implemented in Task 7) ─────────────────────────────
async function initDecoding() { /* replaced in Task 7 */ }

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

export async function run(argv) {
  let req;
  try {
    req = parseRequest(argv);
  } catch (e) {
    process.stderr.write(e.message + '\n');
    process.exit(1);
  }

  const port = await findAvailablePort();
  const html = buildHtml(req, port);
  const { result, close } = startServer(port, html);

  const timeout = setTimeout(() => {
    close();
    process.stderr.write('timeout: user did not respond\n');
    process.exit(1);
  }, TIMEOUT_MS);

  openBrowser(`http://localhost:${port}`);

  result
    .then(data => {
      clearTimeout(timeout);
      close();
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
// Only execute when run directly (not when imported by tests).

const isMain = process.argv[1] &&
  new URL(import.meta.url).pathname === process.argv[1];

if (isMain) {
  run(process.argv);
}
