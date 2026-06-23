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
