# agent-wallet-signer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-file `npx` utility that lets AI agents surface wallet signing requests to users via a local browser page backed by `window.ethereum`.

**Architecture:** A Node.js CLI (`bin/index.js`) parses a transaction JSON from argv, starts a local HTTP server on a random port, bakes the request data into a served HTML page, opens the browser, and waits for `POST /result` from the page. The HTML is embedded as a template string — no build step. Browser logic handles chain switching, EIP-1559 gas estimation, signing, and calldata decoding via whatsabi.

**Tech Stack:** Node.js 18+ (ESM, `node:http`, `node:net`, `node:child_process`, `node:test`), vanilla JS/HTML browser page, whatsabi from `esm.sh` CDN for calldata decoding, `window.ethereum` (EIP-1193) for wallet interaction.

## Global Constraints

- Node.js ≥ 18 required — uses `node:test` (built-in) and native ESM
- `"type": "module"` in package.json — all JS uses `import`/`export`
- Zero runtime npm dependencies — `bin/index.js` uses only Node.js built-ins
- No build step — `bin/index.js` is the final artifact, HTML embedded as a template string
- EIP-1559 transactions only (`type: "0x2"`) — `gasPrice` not supported
- Test runner: `node --test` (no test framework dependency)

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `bin/index.js` (stub)
- Create: `test/request.test.js` (stub)
- Create: `README.md`

**Interfaces:**
- Produces: `package.json` with `"bin": { "agent-wallet-signer": "./bin/index.js" }`, `"type": "module"`, `"engines": { "node": ">=18" }`, `"scripts": { "test": "node --test" }`

- [ ] **Step 1: Create package.json**

`package.json`:
```json
{
  "name": "agent-wallet-signer",
  "version": "0.1.0",
  "description": "Let AI agents surface wallet signing requests to users via a local browser page",
  "type": "module",
  "engines": { "node": ">=18" },
  "bin": { "agent-wallet-signer": "./bin/index.js" },
  "scripts": { "test": "node --test" },
  "files": ["bin/index.js"],
  "keywords": ["wallet", "ethereum", "signing", "agent", "cli"],
  "license": "MIT"
}
```

- [ ] **Step 2: Create bin/index.js stub**

`bin/index.js`:
```javascript
#!/usr/bin/env node
// agent-wallet-signer: surfaces wallet signing requests via a local browser page

console.log('agent-wallet-signer');
```

- [ ] **Step 3: Make bin/index.js executable**

```bash
chmod +x bin/index.js
```

- [ ] **Step 4: Create test/request.test.js stub**

`test/request.test.js`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('placeholder', () => {
  assert.ok(true);
});
```

- [ ] **Step 5: Run tests to verify setup**

```bash
node --test
```
Expected output: `✔ placeholder`

- [ ] **Step 6: Commit**

```bash
git add package.json bin/index.js test/request.test.js .gitignore
git commit -m "chore: scaffold project"
```

---

### Task 2: Request parsing and type inference

**Files:**
- Modify: `bin/index.js`
- Modify: `test/request.test.js`

**Interfaces:**
- Produces: `export function parseRequest(argv: string[]): ParsedRequest`
- `ParsedRequest` shape: `{ _type: 'sendTransaction' | 'signTypedData' | 'personalSign', chainId: number, value: string, label?: string, description?: string, ...all original fields }`
- Throws `Error` with a human-readable message on any invalid input

- [ ] **Step 1: Write failing tests**

Replace `test/request.test.js`:
```javascript
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
```

- [ ] **Step 2: Run tests, confirm they all fail**

```bash
node --test test/request.test.js
```
Expected: all tests fail with `SyntaxError: The requested module '../bin/index.js' does not provide an export named 'parseRequest'`

- [ ] **Step 3: Implement parseRequest**

Replace `bin/index.js` with:
```javascript
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
```

- [ ] **Step 4: Run tests, confirm all pass**

```bash
node --test test/request.test.js
```
Expected: all 12 tests pass

- [ ] **Step 5: Commit**

```bash
git add bin/index.js test/request.test.js
git commit -m "feat: add request parsing and type inference"
```

---

### Task 3: HTTP server, port finding, and browser open

**Files:**
- Modify: `bin/index.js`
- Create: `test/server.test.js`

**Interfaces:**
- Produces: `export function findAvailablePort(): Promise<number>`
- Produces: `export function startServer(port: number, html: string): { result: Promise<object>, close: () => void }`
  - `result` resolves with the JSON body POSTed to `/result`
  - `close()` shuts down the HTTP server
- Produces: `export function openBrowser(url: string): void`

- [ ] **Step 1: Write failing tests**

Create `test/server.test.js`:
```javascript
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
```

- [ ] **Step 2: Run tests, confirm they fail**

```bash
node --test test/server.test.js
```
Expected: all tests fail with missing exports

- [ ] **Step 3: Implement findAvailablePort, startServer, and openBrowser**

Append to `bin/index.js`:
```javascript
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
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        try {
          resolveResult(JSON.parse(body));
        } catch (e) {
          rejectResult(new Error(`Bad result payload: ${e.message}`));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, '127.0.0.1');
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
```

- [ ] **Step 4: Run all tests**

```bash
node --test
```
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add bin/index.js test/server.test.js
git commit -m "feat: add HTTP server, port finding, and browser open"
```

---

### Task 4: Main orchestration and timeout

**Files:**
- Modify: `bin/index.js`
- Create: `test/main.test.js`

**Interfaces:**
- Produces: `export async function run(argv: string[]): Promise<void>`
  - On parse error: writes to stderr, calls `process.exit(1)`
  - On success: writes JSON to stdout, calls `process.exit(0)`
  - On timeout: writes `"timeout: user did not respond"` to stderr, calls `process.exit(1)`
- Consumes: `parseRequest`, `findAvailablePort`, `startServer`, `openBrowser`, `buildHtml` (stubbed here, replaced in Task 5)

- [ ] **Step 1: Write failing test**

Create `test/main.test.js`:
```javascript
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
```

- [ ] **Step 2: Run test, confirm it fails**

```bash
node --test test/main.test.js
```
Expected: fails with missing export `run`

- [ ] **Step 3: Add buildHtml stub and run() to bin/index.js**

Append to `bin/index.js`:
```javascript
// ── HTML builder stub ─────────────────────────────────────────────────────────
// Replaced in full in Task 5. Minimal placeholder so run() can start the server.

export function buildHtml(req, port) {
  return `<!DOCTYPE html><html><body>
    <p>Loading…</p>
    <script>
      const RESULT_URL = 'http://localhost:${port}/result';
      const REQUEST = ${JSON.stringify(req)};
    </script>
  </body></html>`;
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
```

- [ ] **Step 4: Run all tests**

```bash
node --test
```
Expected: all tests pass

- [ ] **Step 5: Smoke-test the CLI error path**

```bash
node bin/index.js 2>&1 | head -1
```
Expected: `Usage: agent-wallet-signer '<request JSON>'`

- [ ] **Step 6: Commit**

```bash
git add bin/index.js test/main.test.js
git commit -m "feat: add main orchestration with 5-minute timeout"
```

---

### Task 5: HTML template — structure, UI states, wallet detection, and connect flow

**Files:**
- Modify: `bin/index.js` — replace `buildHtml` stub with full implementation
- Create: `test/html.test.js`

**Interfaces:**
- Consumes: `buildHtml(req: ParsedRequest, port: number): string` — same signature as stub
- The returned HTML must set `body[data-state]` to control visibility of `[data-show]` sections
- UI states: `'ready'` | `'wrong-chain'` | `'waiting'` | `'done'` | `'error'` | `'no-wallet'`
- Browser globals injected into HTML: `REQUEST` (the full parsed request object), `RESULT_URL` (the POST endpoint), `CHAIN_META` (chain metadata map)

- [ ] **Step 1: Write failing tests**

Create `test/html.test.js`:
```javascript
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
```

- [ ] **Step 2: Run tests, confirm they fail**

```bash
node --test test/html.test.js
```
Expected: all 8 tests fail (stub HTML is too minimal)

- [ ] **Step 3: Replace buildHtml stub with full template**

In `bin/index.js`, replace the entire `buildHtml` function (keep `escHtml` as-is) with:

```javascript
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

  <div data-show="done">
    <h1>✓ Done</h1>
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
const REQUEST    = ${JSON.stringify(req)};
const RESULT_URL = 'http://localhost:${port}/result';
const CHAIN_META = ${JSON.stringify(CHAINS)};

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
```

- [ ] **Step 4: Run all tests**

```bash
node --test
```
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add bin/index.js test/html.test.js
git commit -m "feat: add full HTML template with UI states and wallet detection"
```

---

### Task 6: Chain switching, EIP-1559 gas estimation, and signing

**Files:**
- Modify: `bin/index.js` — replace `onConnect` stub inside the `buildHtml` template string

**Interfaces:**
- Consumes (browser globals): `REQUEST`, `RESULT_URL`, `CHAIN_META`, `setState`, `postResult`, `hex`, `trunc`
- Produces: completed `onConnect()` function — chain detection → switch if needed → gas estimation → sign → postResult → show done/error

- [ ] **Step 1: Write failing HTML content tests**

Add to `test/html.test.js`:
```javascript
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
```

- [ ] **Step 2: Run new tests, confirm they fail**

```bash
node --test test/html.test.js
```
Expected: 9 new tests fail (stubs don't contain these strings)

- [ ] **Step 3: Replace onConnect stub in buildHtml**

Inside `buildHtml`, replace `async function onConnect() { /* replaced in Task 6 */ }` with:

```javascript
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
    if (parseInt(currentChainHex, 16) !== REQUEST.chainId) {
      setState('wrong-chain');
      btn.textContent = \`Switch to \${(CHAIN_META[REQUEST.chainId] || {}).name || 'required chain'}\`;
      btn.disabled = false;
      btn.onclick = () => switchChain(account);
      return;
    }
    await sign(account);
  } catch (e) {
    showError(e.message || String(e));
  }
}

async function switchChain(account) {
  const btn = document.getElementById('btn');
  btn.disabled = true;
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
    tx.gas = hex(Math.ceil(parseInt(est, 16) * 1.2));
  }

  // EIP-1559 fees
  if (REQUEST.maxFeePerGas && REQUEST.maxPriorityFeePerGas) {
    tx.maxFeePerGas = REQUEST.maxFeePerGas;
    tx.maxPriorityFeePerGas = REQUEST.maxPriorityFeePerGas;
  } else {
    const [priorityFeeHex, block] = await Promise.all([
      window.ethereum.request({ method: 'eth_maxPriorityFeePerGas' }),
      window.ethereum.request({ method: 'eth_getBlockByNumber', params: ['latest', false] }),
    ]);
    const priorityFee = BigInt(priorityFeeHex);
    const baseFee     = BigInt(block.baseFeePerGas);
    tx.maxPriorityFeePerGas = hex(priorityFee);
    tx.maxFeePerGas         = hex(baseFee * 2n + priorityFee);
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

  } catch (e) {
    showError(e.message || String(e));
  }
}
```

- [ ] **Step 4: Run all tests**

```bash
node --test
```
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add bin/index.js test/html.test.js
git commit -m "feat: add chain switching, EIP-1559 gas estimation, and signing"
```

---

### Task 7: whatsabi calldata decoding

**Files:**
- Modify: `bin/index.js` — replace `initDecoding` stub inside the `buildHtml` template string

**Interfaces:**
- Consumes (browser globals): `REQUEST`
- Produces: populates `#decode` element with decoded function name and argument values; silently skips on any failure
- `loaders.SigHashLoader` from `@shazow/whatsabi` (loaded via `esm.sh`) resolves a 4-byte hex selector to a function signature string

- [ ] **Step 1: Write failing tests**

Add to `test/html.test.js`:
```javascript
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

test('HTML contains decodeCalldata function', () => {
  const html = buildHtml(makeReq(), 3000);
  assert.ok(html.includes('decodeCalldata'));
});

test('HTML contains decodeSlot function for ABI decoding', () => {
  const html = buildHtml(makeReq(), 3000);
  assert.ok(html.includes('decodeSlot'));
});
```

- [ ] **Step 2: Run new tests, confirm they fail**

```bash
node --test test/html.test.js
```
Expected: 4 new tests fail

- [ ] **Step 3: Replace initDecoding stub in buildHtml**

Inside `buildHtml`, replace `async function initDecoding() { /* replaced in Task 7 */ }` with:

```javascript
// Manual ABI decoder for fixed-size slot types.
// Covers the most common parameter types (address, uint*, bool, bytes32).
// Dynamic types (string, bytes[], tuples) fall back to "(complex type)".
function decodeSlot(type, slot) {
  if (type === 'address')                  return '0x' + slot.slice(-40);
  if (/^u?int(\\d+)?$/.test(type)) {
    try { return BigInt('0x' + slot).toString(); } catch { return '0x' + slot; }
  }
  if (type === 'bool')                     return slot.endsWith('1') ? 'true' : 'false';
  if (/^bytes(\\d+)?$/.test(type))         return '0x' + slot;
  return '(complex type)';
}

function decodeCalldata(hexData, sig) {
  const match = sig.match(/^\\w+\\((.*)\\)$/);
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
    const decoded = decodeCalldata(data, sig);

    decodeEl.style.display = 'block';
    let inner = \`<div class="decode-title">Calling: \${sig}</div>\`;
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
```

- [ ] **Step 4: Run all tests**

```bash
node --test
```
Expected: all tests pass

- [ ] **Step 5: End-to-end manual test**

Run this command (requires MetaMask or Rabby installed):
```bash
node bin/index.js '{"label":"Test: USDC transfer","description":"Simulated transfer call for testing.","chainId":1,"to":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","data":"0xa9059cbb000000000000000000000000ab5801a7d398351b8be11c439e05c5b3259aec9b0000000000000000000000000000000000000000000000000000000000f42400","value":"0x0"}'
```

Expected:
1. Browser opens at `http://localhost:<PORT>`
2. Page shows heading "Test: USDC transfer"
3. Summary shows Chain: Ethereum, To: 0xA0b8…eB48
4. Decode section shows `Calling: transfer(address,uint256)` with:
   - `address` → `0xab5801a7d398351b8be11c439e05c5b3259aec9b`
   - `uint256` → `1000000`
5. Connect Wallet button is visible
6. After connecting MetaMask on mainnet and approving: stdout prints `{"hash":"0x...","chainId":1}`
7. CLI exits 0

- [ ] **Step 6: Final commit**

```bash
git add bin/index.js test/html.test.js
git commit -m "feat: add whatsabi calldata decoding with graceful fallback"
```
