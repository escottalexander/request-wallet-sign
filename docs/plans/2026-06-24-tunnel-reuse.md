# Lazy, Reusable Cloudflare Tunnel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cross-device signing lazy (browser-triggered, no upfront wait) and reuse one `cloudflared` tunnel across invocations via a state file, so high-volume signing no longer gets throttled — while leaving the default local-only flow untouched.

**Architecture:** A deterministic preferred port (`8456`) lets sequential signing servers share one detached `cloudflared` process recorded in `~/.agent-wallet-signer/state.json`. The browser page exposes a "Sign on another device" button that POSTs to new `/tunnel/start` and `/tunnel/check` server endpoints; the tunnel is started/reused on demand and verified by an explicit user-triggered server-side probe.

**Tech Stack:** Node.js (built-ins only: `http`, `net`, `child_process`, `fs`, `os`, `path`, global `fetch`). Tests via `node --test`. No runtime dependencies; `cloudflared` is fetched on demand via `npx -y cloudflared`.

---

## File Structure

- **Modify** `bin/index.js` — the entire implementation. New sections: state-file helpers, `decideTunnelAction`, port selection, `cloudflared` start/probe, tunnel controller, `stopTunnel`, two server endpoints, `buildHtml` UI changes, `run()` rewiring.
- **Modify** `test/request.test.js` — extend `parseOptions` tests for `--stop-tunnel`.
- **Modify** `test/html.test.js` — replace static-tunnel-URL tests with cross-device-button tests.
- **Modify** `test/server.test.js` — add `/tunnel/start` and `/tunnel/check` routing tests.
- **Create** `test/state.test.js` — state-file + `decideTunnelAction` + `stopTunnel` tests.
- **Create** `test/tunnel.test.js` — `extractTunnelUrl` + tunnel-controller (`start`/`check`) tests with injected deps.
- **Create** `test/port.test.js` — `isPortFree` / `choosePort` tests.
- **Modify** `README.md` and `HELP_TEXT` — document lazy tunnel, reuse, `--stop-tunnel`.

Remove the now-obsolete `spawnTunnel`, `waitReachable`, and `establishTunnel` functions (replaced by `startCloudflared` + `probeUrl` + the controller).

Constants to add near the top of the relevant section:
```js
const PREFERRED_PORT = 8456;
const TUNNEL_TTL_MS = 10 * 60 * 1000; // reuse window
```

State-dir resolution (overridable for tests):
```js
import { homedir } from 'node:os';
import { join } from 'node:path';
function stateDir() {
  return process.env.AGENT_WALLET_SIGNER_HOME || join(homedir(), '.agent-wallet-signer');
}
function stateFilePath() { return join(stateDir(), 'state.json'); }
```

---

## Task 1: Extend flag parsing for `--stop-tunnel`

**Files:**
- Modify: `bin/index.js` (the existing `parseOptions`)
- Test: `test/request.test.js`

- [ ] **Step 1: Write the failing test**

Add to `test/request.test.js`:
```js
test('parseOptions detects --stop-tunnel flag', () => {
  assert.equal(parseOptions(['node', 's', '--stop-tunnel']).stopTunnel, true);
  assert.equal(parseOptions(['node', 's', '{}']).stopTunnel, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/request.test.js`
Expected: FAIL — `stopTunnel` is `undefined`, not `true`/`false`.

- [ ] **Step 3: Implement**

Replace `parseOptions` body:
```js
export function parseOptions(argv) {
  const args = argv.slice(2);
  return {
    tunnel: args.includes('--tunnel'),
    stopTunnel: args.includes('--stop-tunnel'),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/request.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/index.js test/request.test.js
git commit -m "feat: parse --stop-tunnel flag"
```

---

## Task 2: State-file helpers

**Files:**
- Modify: `bin/index.js`
- Test: `test/state.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `test/state.test.js`:
```js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, writeState, clearState, isPidAlive } from '../bin/index.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aws-')); process.env.AGENT_WALLET_SIGNER_HOME = dir; });
afterEach(() => { delete process.env.AGENT_WALLET_SIGNER_HOME; rmSync(dir, { recursive: true, force: true }); });

test('readState returns null when no file', () => {
  assert.equal(readState(), null);
});

test('writeState then readState round-trips', () => {
  writeState({ port: 8456, url: 'https://x.trycloudflare.com', pid: 1, startedAt: 1, lastUsedAt: 2 });
  assert.deepEqual(readState(), { port: 8456, url: 'https://x.trycloudflare.com', pid: 1, startedAt: 1, lastUsedAt: 2 });
});

test('clearState removes the file', () => {
  writeState({ port: 8456, url: 'u', pid: 1, startedAt: 1, lastUsedAt: 2 });
  clearState();
  assert.equal(readState(), null);
});

test('isPidAlive is true for current process, false for unused pid', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(999999999), false);
  assert.equal(isPidAlive(undefined), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/state.test.js`
Expected: FAIL — exports don't exist.

- [ ] **Step 3: Implement**

Add to `bin/index.js` (with the imports listed in File Structure):
```js
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/state.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add bin/index.js test/state.test.js
git commit -m "feat: add tunnel state-file helpers"
```

---

## Task 3: `decideTunnelAction` (pure reuse/replace/start logic)

**Files:**
- Modify: `bin/index.js`
- Test: `test/state.test.js`

- [ ] **Step 1: Write the failing test**

Add to `test/state.test.js` (and add `decideTunnelAction, TUNNEL_TTL_MS` to the import):
```js
import { decideTunnelAction, TUNNEL_TTL_MS } from '../bin/index.js';

test('decideTunnelAction: no state -> start', () => {
  assert.equal(decideTunnelAction(null, 8456, 1000, false).action, 'start');
});

test('decideTunnelAction: live, fresh, same port -> reuse', () => {
  const state = { port: 8456, url: 'https://x.trycloudflare.com', pid: 5, startedAt: 0, lastUsedAt: 1000 };
  const d = decideTunnelAction(state, 8456, 1000 + TUNNEL_TTL_MS - 1, true);
  assert.equal(d.action, 'reuse');
  assert.equal(d.url, 'https://x.trycloudflare.com');
});

test('decideTunnelAction: stale -> replace with pid', () => {
  const state = { port: 8456, url: 'u', pid: 5, startedAt: 0, lastUsedAt: 1000 };
  const d = decideTunnelAction(state, 8456, 1000 + TUNNEL_TTL_MS, true);
  assert.equal(d.action, 'replace');
  assert.equal(d.pid, 5);
});

test('decideTunnelAction: dead pid -> start', () => {
  const state = { port: 8456, url: 'u', pid: 5, startedAt: 0, lastUsedAt: 1000 };
  assert.equal(decideTunnelAction(state, 8456, 1000, false).action, 'start');
});

test('decideTunnelAction: live but different port -> start', () => {
  const state = { port: 9999, url: 'u', pid: 5, startedAt: 0, lastUsedAt: 1000 };
  assert.equal(decideTunnelAction(state, 8456, 1000, true).action, 'start');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/state.test.js`
Expected: FAIL — `decideTunnelAction` / `TUNNEL_TTL_MS` undefined.

- [ ] **Step 3: Implement**

Add to `bin/index.js`:
```js
export const TUNNEL_TTL_MS = 10 * 60 * 1000;

// Pure: caller passes `alive` (computed via isPidAlive) so this stays testable.
export function decideTunnelAction(state, port, now, alive, ttl = TUNNEL_TTL_MS) {
  if (!state || !state.url || !alive) return { action: 'start' };
  if (now - state.lastUsedAt >= ttl) return { action: 'replace', pid: state.pid };
  if (state.port !== port) return { action: 'start' };
  return { action: 'reuse', url: state.url };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/state.test.js`
Expected: PASS (9 tests total in file).

- [ ] **Step 5: Commit**

```bash
git add bin/index.js test/state.test.js
git commit -m "feat: add decideTunnelAction reuse logic"
```

---

## Task 4: Port selection (`isPortFree` / `choosePort`)

**Files:**
- Modify: `bin/index.js`
- Test: `test/port.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `test/port.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { isPortFree, choosePort, findAvailablePort } from '../bin/index.js';

test('isPortFree true for an unused port, false when taken', async () => {
  const port = await findAvailablePort();
  assert.equal(await isPortFree(port), true);
  const srv = createServer().listen(port, '0.0.0.0');
  await new Promise(r => srv.once('listening', r));
  assert.equal(await isPortFree(port), false);
  await new Promise(r => srv.close(r));
});

test('choosePort returns preferred when free', async () => {
  const port = await findAvailablePort();
  assert.equal(await choosePort(port), port);
});

test('choosePort falls back to a different free port when preferred is taken', async () => {
  const port = await findAvailablePort();
  const srv = createServer().listen(port, '0.0.0.0');
  await new Promise(r => srv.once('listening', r));
  const chosen = await choosePort(port);
  assert.notEqual(chosen, port);
  assert.equal(typeof chosen, 'number');
  await new Promise(r => srv.close(r));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/port.test.js`
Expected: FAIL — `isPortFree` / `choosePort` undefined.

- [ ] **Step 3: Implement**

Add to `bin/index.js` (near `findAvailablePort`):
```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/port.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add bin/index.js test/port.test.js
git commit -m "feat: add preferred-port selection"
```

---

## Task 5: `extractTunnelUrl` + replace old tunnel functions

**Files:**
- Modify: `bin/index.js` (remove `spawnTunnel`, `waitReachable`, `establishTunnel`; add `extractTunnelUrl`, `startCloudflared`, `probeUrl`)
- Test: `test/tunnel.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `test/tunnel.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTunnelUrl } from '../bin/index.js';

test('extractTunnelUrl pulls the trycloudflare URL from log noise', () => {
  const log = 'INF Requesting new quick Tunnel on trycloudflare.com...\n' +
    'INF |  https://services-proud-voice.trycloudflare.com  |';
  assert.equal(extractTunnelUrl(log), 'https://services-proud-voice.trycloudflare.com');
});

test('extractTunnelUrl returns null when no URL present', () => {
  assert.equal(extractTunnelUrl('nothing here'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tunnel.test.js`
Expected: FAIL — `extractTunnelUrl` undefined.

- [ ] **Step 3: Implement**

In `bin/index.js`, delete `spawnTunnel`, `waitReachable`, and `establishTunnel`. Add:
```js
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
```

Also remove the `establishTunnel`-based block and its stderr lines from `run()` for now (Task 9 rewires `run()` fully; if removal breaks `run()` temporarily that's fine — tests don't import `run` behavior here, and Task 9 restores it). To keep the file parseable in the meantime, leave `run()` calling `buildHtml(req, port, networkUrl)` with no tunnel args.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/tunnel.test.js`
Expected: PASS (2 tests). Also run `node --check bin/index.js` — Expected: no syntax error.

- [ ] **Step 5: Commit**

```bash
git add bin/index.js test/tunnel.test.js
git commit -m "feat: add extractTunnelUrl + detached cloudflared start; drop blocking establishTunnel"
```

---

## Task 6: Tunnel controller (`createTunnelController`) + `stopTunnel`

**Files:**
- Modify: `bin/index.js`
- Test: `test/tunnel.test.js`, `test/state.test.js`

- [ ] **Step 1: Write the failing test**

Add to `test/tunnel.test.js`:
```js
import { createTunnelController } from '../bin/index.js';

function fakeDeps(overrides = {}) {
  const calls = { written: [], started: 0 };
  return {
    calls,
    deps: {
      now: () => 1000,
      readState: () => overrides.state ?? null,
      writeState: s => calls.written.push(s),
      isPidAlive: () => overrides.alive ?? false,
      startCloudflared: async () => { calls.started++; return overrides.startResult ?? { url: 'https://new.trycloudflare.com', pid: 42 }; },
      probeUrl: async () => overrides.reachable ?? true,
      log: () => {},
    },
  };
}

test('controller.start starts a new tunnel when no state', async () => {
  const { deps, calls } = fakeDeps();
  const c = createTunnelController(8456, deps);
  const out = await c.start();
  assert.equal(out.url, 'https://new.trycloudflare.com');
  assert.equal(calls.started, 1);
  assert.equal(calls.written[0].pid, 42);
});

test('controller.start reuses a live fresh same-port tunnel', async () => {
  const { deps, calls } = fakeDeps({
    state: { port: 8456, url: 'https://old.trycloudflare.com', pid: 7, startedAt: 0, lastUsedAt: 1000 },
    alive: true,
  });
  const c = createTunnelController(8456, deps);
  const out = await c.start();
  assert.equal(out.url, 'https://old.trycloudflare.com');
  assert.equal(calls.started, 0); // reused, not started
});

test('controller.start returns error when cloudflared yields no URL', async () => {
  const { deps } = fakeDeps({ startResult: null });
  const c = createTunnelController(8456, deps);
  assert.ok((await c.start()).error);
});

test('controller.check reports reachability of stored url', async () => {
  const { deps } = fakeDeps({ state: { url: 'https://x.trycloudflare.com' }, reachable: false });
  const c = createTunnelController(8456, deps);
  assert.deepEqual(await c.check(), { reachable: false });
});
```

Add to `test/state.test.js`:
```js
import { stopTunnel } from '../bin/index.js';

test('stopTunnel kills the tracked pid and clears state', () => {
  let killed = null;
  writeState({ port: 8456, url: 'https://x.trycloudflare.com', pid: 123, startedAt: 0, lastUsedAt: 0 });
  const url = stopTunnel({ kill: pid => { killed = pid; } });
  assert.equal(killed, 123);
  assert.equal(url, 'https://x.trycloudflare.com');
  assert.equal(readState(), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tunnel.test.js test/state.test.js`
Expected: FAIL — `createTunnelController` / `stopTunnel` undefined.

- [ ] **Step 3: Implement**

Add to `bin/index.js`:
```js
export function createTunnelController(port, deps = {}) {
  const read  = deps.readState      || readState;
  const write = deps.writeState     || writeState;
  const alive = deps.isPidAlive     || isPidAlive;
  const start = deps.startCloudflared || startCloudflared;
  const probe = deps.probeUrl       || probeUrl;
  const now   = deps.now            || (() => Date.now());
  const log   = deps.log            || (() => {});
  return {
    async start() {
      const t = now();
      const state = read();
      const decision = decideTunnelAction(state, port, t, alive(state?.pid));
      if (decision.action === 'reuse') {
        write({ ...state, lastUsedAt: t });
        log(`reusing tunnel ${decision.url}`);
        return { url: decision.url };
      }
      if (decision.action === 'replace' && decision.pid) {
        try { process.kill(decision.pid); } catch {}
      }
      const res = await start(port);
      if (!res) return { error: 'could not start tunnel' };
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

export function stopTunnel(deps = {}) {
  const read  = deps.readState  || readState;
  const clear = deps.clearState || clearState;
  const kill  = deps.kill       || (pid => process.kill(pid));
  const state = read();
  if (state && state.pid) { try { kill(state.pid); } catch {} }
  clear();
  return state ? state.url : null;
}
```

Note: inside `start()` the local `const start = deps.startCloudflared || startCloudflared` shadows nothing problematic, but rename the dep alias to avoid confusion with the method name:
```js
const startProc = deps.startCloudflared || startCloudflared;
// ...
const res = await startProc(port);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/tunnel.test.js test/state.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/index.js test/tunnel.test.js test/state.test.js
git commit -m "feat: add tunnel controller and stopTunnel"
```

---

## Task 7: Server endpoints `/tunnel/start` and `/tunnel/check`

**Files:**
- Modify: `bin/index.js` (`startServer` signature `(port, html, tunnel)` + routing)
- Test: `test/server.test.js`

- [ ] **Step 1: Write the failing test**

Add to `test/server.test.js`:
```js
test('startServer routes /tunnel/start and /tunnel/check to the controller', async () => {
  const port = await findAvailablePort();
  const fakeTunnel = {
    start: async () => ({ url: 'https://x.trycloudflare.com' }),
    check: async () => ({ reachable: true }),
  };
  const { close } = startServer(port, '<html></html>', fakeTunnel);
  const s = await (await fetch(`http://localhost:${port}/tunnel/start`, { method: 'POST' })).json();
  assert.equal(s.url, 'https://x.trycloudflare.com');
  const c = await (await fetch(`http://localhost:${port}/tunnel/check`, { method: 'POST' })).json();
  assert.equal(c.reachable, true);
  close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server.test.js`
Expected: FAIL — endpoints return 404 (no `url` in JSON).

- [ ] **Step 3: Implement**

Change `startServer(port, html)` to `startServer(port, html, tunnel)` and make the handler `async`. Add, before the final `else { res.writeHead(404); res.end(); }`:
```js
    } else if (req.method === 'POST' && req.url === '/tunnel/start' && tunnel) {
      const out = await tunnel.start();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    } else if (req.method === 'POST' && req.url === '/tunnel/check' && tunnel) {
      const out = await tunnel.check();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server.test.js`
Expected: PASS (existing server tests still pass too).

- [ ] **Step 5: Commit**

```bash
git add bin/index.js test/server.test.js
git commit -m "feat: serve /tunnel/start and /tunnel/check endpoints"
```

---

## Task 8: `buildHtml` — lazy cross-device UI

**Files:**
- Modify: `bin/index.js` (`buildHtml` signature → `(req, port, networkUrl, opts)`, UI + JS)
- Test: `test/html.test.js`

- [ ] **Step 1: Write the failing test**

In `test/html.test.js`, REPLACE the four tests that reference `tunnelUrl`/`copy-tunnel-btn`/throttle (`HTML shows the tunnel URL when provided`, `HTML omits tunnel section when no tunnel URL`, `HTML hides the LAN section when a tunnel URL is shown`, `HTML shows LAN URL with a throttle caveat when tunnel throttled`) with:
```js
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
```
Keep the existing `HTML includes network URL copy button when networkUrl provided` test only if it still matches; otherwise update its assertion to `id="copy-url-btn"` within the cross-device area (the LAN copy button still exists).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/html.test.js`
Expected: FAIL — `cross-device-btn`, `/tunnel/start`, `AUTO_TUNNEL` not present.

- [ ] **Step 3: Implement**

Change the signature:
```js
export function buildHtml(req, port, networkUrl, opts = {}) {
  const autoTunnel = !!opts.autoTunnel;
```
Remove the old `tunnelUrl`/`tunnelThrottled` `connectivityHtml` branch. Replace the connectivity markup (the `${connectivityHtml}` line) with:
```html
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
```
Add `AUTO_TUNNEL` to the injected JS constants block:
```js
const AUTO_TUNNEL = ${autoTunnel};
```
Replace the old `wireCopyUrl(...)` lines and add the cross-device wiring (place in the init block, runs regardless of wallet state):
```js
function showTunnel(url) {
  document.getElementById('cd-tunnel-link').href = url;
  document.getElementById('cd-tunnel-link').textContent = url;
  document.getElementById('cd-tunnel-row').style.display = 'flex';
  document.getElementById('cd-check-btn').style.display = 'block';
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
function showStatus(msg) {
  const el = document.getElementById('cd-status');
  el.textContent = msg;
  el.style.display = 'block';
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
if (AUTO_TUNNEL) startTunnel();
```
Add `.cross-device { margin-top: 1.25rem; }` to the stylesheet (the `.network-info`, `.tunnel`, `.net-caveat`, `.icon-btn` styles already exist).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/html.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/index.js test/html.test.js
git commit -m "feat: lazy cross-device tunnel UI with manual reachability check"
```

---

## Task 9: Rewire `run()` — lazy tunnel, preferred port, persist on exit

**Files:**
- Modify: `bin/index.js` (`run`)
- Verification: live (manual)

- [ ] **Step 1: Implement `run()`**

Replace the body of `run()` with:
```js
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
```

- [ ] **Step 2: Syntax check + full unit run**

Run: `node --check bin/index.js && node --test`
Expected: all tests PASS.

- [ ] **Step 3: Live — default local flow unchanged, no state created**

Run:
```bash
rm -rf ~/.agent-wallet-signer
node bin/index.js '{"chainId":11155111,"to":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","value":"0x38d7ea4c68000","label":"Local only"}' >/dev/null 2>/tmp/a.err &
sleep 1
curl -s "http://localhost:$(grep -oE ':[0-9]{2,5}' /tmp/a.err | head -1 | tr -d ':')/" | grep -c 'id="cross-device-btn"'
test -e ~/.agent-wallet-signer/state.json && echo "STATE EXISTS (bad)" || echo "no state file (good)"
pkill -f 'bin/index.js'
```
Expected: `1` (button present) and `no state file (good)`.

- [ ] **Step 4: Commit**

```bash
git add bin/index.js
git commit -m "feat: lazy tunnel run() with preferred port and persistent reuse"
```

---

## Task 10: Live end-to-end — lazy start, reuse, stop

**Files:** none (manual verification)

- [ ] **Step 1: Lazy start + reuse across two invocations**

Run signer #1, click "Sign on another device" in the opened page, confirm a `https://*.trycloudflare.com` URL appears and `~/.agent-wallet-signer/state.json` is written with a `pid`. Sign or close. Then run signer #2 and click the button again — confirm the SAME URL returns **instantly** with no new `cloudflared` (check `pgrep -fl cloudflared` shows a single process; stderr logs `reusing tunnel`).

Expected: second invocation reuses; only one cloudflared process exists.

- [ ] **Step 2: `--stop-tunnel`**

Run: `node bin/index.js --stop-tunnel`
Expected: stderr `stopped tunnel https://…`; `pgrep -fl cloudflared` empty; `~/.agent-wallet-signer/state.json` gone.

- [ ] **Step 3: Throttled fallback**

If Cloudflare is throttling (URL never reachable), confirm "Check reachability" shows the ⚠ retry message and the same-network URL remains usable. (No code change — observational.)

---

## Task 11: Docs — README + HELP_TEXT

**Files:**
- Modify: `bin/index.js` (`HELP_TEXT`)
- Modify: `README.md`

- [ ] **Step 1: Update `HELP_TEXT`**

Replace the OPTIONS section of `HELP_TEXT` with:
```
OPTIONS
  --tunnel       Pre-start the cross-device HTTPS tunnel as soon as the page
                 loads (otherwise it starts when you click "Sign on another
                 device" in the page). Cross-device signing requires this tunnel
                 because mobile wallets only inject a provider over HTTPS.
  --stop-tunnel  Tear down the shared background cloudflared tunnel and exit.
  --help, -h     Show this help.

Cross-device tunnels are REUSED across invocations (recorded in
~/.agent-wallet-signer/state.json) so signing many transactions does not create
many tunnels. The tunnel is a single background process; it is reaped after
10 minutes idle, or immediately with --stop-tunnel.
```

- [ ] **Step 2: Update `README.md`**

Replace the "⚠️ Signing on another device requires `--tunnel`" section with a description of: the in-page "Sign on another device" button, lazy start, reuse via the state file, the manual "Check reachability" step, and `--stop-tunnel`. State that the default invocation is local-only with zero tunnel overhead.

- [ ] **Step 3: Commit**

```bash
git add bin/index.js README.md
git commit -m "docs: document lazy reusable tunnel and --stop-tunnel"
```

---

## Self-Review Notes (already reconciled)

- **Spec coverage:** lazy start (Task 8/9), reuse + state file (Tasks 2/3/6/9), preferred port (Task 4/9), endpoints (Task 7), manual verification (Task 7/8), `--stop-tunnel` (Tasks 1/6/9), TTL via `decideTunnelAction` (Task 3), docs (Task 11), unchanged local flow (Task 9 Step 3). All covered.
- **Naming:** `decideTunnelAction`, `createTunnelController`, `stopTunnel`, `startCloudflared`, `probeUrl`, `extractTunnelUrl`, `isPortFree`, `choosePort`, `readState`/`writeState`/`clearState`/`isPidAlive`, `stateDir`/`stateFilePath`, `PREFERRED_PORT`, `TUNNEL_TTL_MS`, `AUTO_TUNNEL` — used consistently across tasks.
- **Dep-alias shadowing** in the controller is resolved by renaming to `startProc` (Task 6 Step 3 note).
```
