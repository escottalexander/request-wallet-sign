# Clear Signing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. NOTE: Tasks 1, 2, and 6 are fully unit-testable (node:test). Tasks 3–5 are browser code (uses `window.ethereum`, dynamic `import()` from esm.sh, `fetch`, DOM) and are verified by **live fixtures in a real browser** (Task 7), not node unit tests — keep their logic thin and push everything testable into the pure helpers of Task 2.

**Goal:** Remove the agent-supplied `label`/`description` and instead show the user what a transaction actually does, decoded from its own data — via ERC-7730 clear-signing descriptors, a resolved-signature semantic layer (4byte/openchain + viem), a generic decoded-call layer, and a raw fallback.

**Architecture:** All user-facing decode logic that can run without a browser lives in a single exported JS-source string `DECODE_HELPERS_JS` (pure functions), unit-tested in node by `eval`-loading it and injected verbatim into the page `<script>`. Thin browser-only glue (dynamic-import viem + whatsabi, `eth_call`, registry `fetch`, DOM writes) calls those pure helpers. Every decode layer degrades gracefully to the next; signing is never blocked.

**Tech Stack:** Node.js built-ins; `node:test`. Browser runtime loads `viem` and `@shazow/whatsabi` from `esm.sh` (not bundled). ERC-7730 descriptors fetched from the GitHub registry raw endpoint.

---

## File Structure

- **Modify** `bin/index.js` — request parsing (strip `label`/`description`), `buildHtml` (header/title, "what this does" UI, inject `DECODE_HELPERS_JS`), add the `DECODE_HELPERS_JS` string + browser glue, remove the old `decodeSlot`/`decodeCalldata`/`initDecoding`/`renderSummary`-label bits.
- **Create** `test/decode.test.js` — unit tests for the pure helpers in `DECODE_HELPERS_JS` (eval-loaded).
- **Modify** `test/request.test.js` — assert `label`/`description` are stripped.
- **Modify** `test/html.test.js` — replace label-title / label-XSS tests with headline + "what this does" + escaping tests.
- **Modify** `skills/wallet-signer/SKILL.md`, `README.md` — drop `label`/`description`, explain the data-derived summary.

### Pure helper API (defined in `DECODE_HELPERS_JS`, Task 2)

All pure (no DOM/network/viem), browser+node safe. Args that are on-chain integers arrive as **decimal strings** (callers do `BigInt(x).toString()` before passing in).

- `awsTrunc(addr)` → `"0x1234…abcd"`.
- `awsFormatAmount(rawDecimal, decimals)` → human decimal string, trailing zeros trimmed (`"1500000", 6` → `"1.5"`).
- `awsIsUnlimited(rawDecimal)` → `BigInt(rawDecimal) >= 2n ** 255n`.
- `awsParseSignature(sig)` → `{ name, types }` from `"transfer(address,uint256)"`.
- `awsPlaceholderTitle(opType)` → `"Review transaction"` | `"Review message"` | `"Review typed-data signature"`.
- `awsDescriptorIndexUrl(kind)` → registry raw URL for `"calldata"` | `"eip712"`.
- `awsFormatDescriptorField(format, value, params)` → display string for the supported ERC-7730 format subset (`raw`, `amount`, `tokenAmount`, `addressName`, `date`, `duration`); unknown format → `String(value)`.
- `awsDescribeCall({ signature, args, symbol, decimals, chainSymbol })` → `{ title, fields: [{label, value, danger}] }` for `transfer`/`transferFrom`/`approve`/`setApprovalForAll`; returns `null` for anything else (caller renders generic).

---

## Task 1: Remove label/description; data-derived headline

**Files:** Modify `bin/index.js`; Test `test/request.test.js`, `test/html.test.js`.

- [ ] **Step 1: Write failing tests.**

In `test/request.test.js` add:
```js
test('parseRequest strips agent-supplied label and description', () => {
  const req = parseRequest(['n','s', JSON.stringify({ chainId: 1, to: '0xabc', label: 'evil', description: 'lies' })]);
  assert.equal(req.label, undefined);
  assert.equal(req.description, undefined);
});
```
In `test/html.test.js`, DELETE the tests named `HTML contains label in page title` and `HTML escapes label to prevent XSS`. Add:
```js
test('HTML has a data-derived headline element and no agent label', () => {
  const html = buildHtml(makeReq({ label: 'Totally Safe', description: 'trust me' }), 3000);
  assert.ok(html.includes('id="headline"'));
  assert.ok(!html.includes('Totally Safe'));
  assert.ok(!html.includes('trust me'));
});
```
(`makeReq` passes extra fields through to the JSON; after Task 1 they are stripped by `parseRequest`, so they must not appear in the HTML.)

- [ ] **Step 2: Run — expect FAIL.** `node --test test/request.test.js test/html.test.js` (label still in title / not stripped).

- [ ] **Step 3: Strip in `parseRequest`.** In `bin/index.js`, in `parseRequest`, after `const req = { ...parsed, _type };` add:
```js
  // Agent-supplied free text is untrusted and must never be shown as if it
  // described the transaction; the page derives its summary from the data.
  delete req.label;
  delete req.description;
```

- [ ] **Step 4: Update `buildHtml` header.** Replace the title line `  <title>${escHtml(label)}</title>` with `  <title>Review &amp; sign</title>`. Remove `const label = ...` and `const description = ...` (lines near the top of `buildHtml`). In the `data-show="ready"` block, replace the header area:
```html
      <h1>${escHtml(label)}</h1>
```
and the description line
```html
    ${description ? `<p class="desc">${escHtml(description)}</p>` : ''}
```
with:
```html
      <h1 id="headline">Review transaction</h1>
```
(The placeholder text is refined to per-op-type via `awsPlaceholderTitle` in Task 2; a static string is fine here.) Leave the existing `id="summary"` and `id="decode"` divs in place — Task 3 repurposes them.

- [ ] **Step 5: Run — expect PASS.** `node --test` (full suite). Fix any other test that referenced `label` (e.g. a `makeReq` default) by leaving the field in the request input but asserting it's stripped/absent in output.

- [ ] **Step 6: Commit.**
```bash
git add bin/index.js test/request.test.js test/html.test.js
git commit -m "feat: strip agent label/description; data-derived headline"
```

---

## Task 2: Pure decode helpers (`DECODE_HELPERS_JS`)

**Files:** Modify `bin/index.js`; Create `test/decode.test.js`.

- [ ] **Step 1: Write failing tests.** Create `test/decode.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DECODE_HELPERS_JS } from '../bin/index.js';

// Load the pure helpers from the same source string that is injected into the page.
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
```

- [ ] **Step 2: Run — expect FAIL.** `node --test test/decode.test.js` (no `DECODE_HELPERS_JS` export).

- [ ] **Step 3: Implement `DECODE_HELPERS_JS`.** In `bin/index.js`, add an exported string constant (near `buildHtml`). The string IS the source of truth, injected into the page in Task 3.
```js
export const DECODE_HELPERS_JS = `
function awsTrunc(a){ return a ? a.slice(0,6) + '\\u2026' + a.slice(-4) : '\\u2014'; }
function awsFormatAmount(rawDecimal, decimals){
  const d = BigInt(decimals||0); const neg = rawDecimal.startsWith('-');
  let v = BigInt(neg ? rawDecimal.slice(1) : rawDecimal);
  const base = 10n ** d; const whole = v / base; let frac = (v % base).toString().padStart(Number(d),'0').replace(/0+$/,'');
  return (neg?'-':'') + whole.toString() + (frac ? '.' + frac : '');
}
function awsIsUnlimited(rawDecimal){ try { return BigInt(rawDecimal) >= (2n ** 255n); } catch { return false; } }
function awsParseSignature(sig){
  const m = sig.match(/^([^(]+)\\((.*)\\)$/); if(!m) return { name: sig, types: [] };
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
  return String(value); // raw + any unsupported format
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
```

- [ ] **Step 4: Run — expect PASS.** `node --test test/decode.test.js`; then `node --test` full suite; `node --check bin/index.js`.

- [ ] **Step 5: Commit.**
```bash
git add bin/index.js test/decode.test.js
git commit -m "feat: pure clear-signing decode helpers (DECODE_HELPERS_JS)"
```

---

## Task 3: Browser decode glue — signature + semantic render (LIVE-VERIFIED)

**Files:** Modify `bin/index.js` (`buildHtml` script). Replaces `decodeSlot`/`decodeCalldata`/`initDecoding` and the label parts of `renderSummary`.

> Browser code — verified live in Task 7, not node unit tests. Keep glue thin; all branching logic lives in the Task 2 helpers. Node tests here only confirm the HTML wires the new pieces and nothing regressed.

- [ ] **Step 1: Inject helpers + add "what this does" container.** In `buildHtml`, inside the `<script type="module">`, immediately after the injected `CHAIN_META` constant, inject the pure helpers: a line containing `${DECODE_HELPERS_JS}`. In the `data-show="ready"` markup, replace `<div class="decode" id="decode"></div>` with:
```html
    <div id="what" class="decode" style="display:none"></div>
```
Add a node structure test in `test/html.test.js`:
```js
test('HTML injects decode helpers and the what-this-does container', () => {
  const html = buildHtml(makeReq(), 3000);
  assert.ok(html.includes('function awsDescribeCall'));
  assert.ok(html.includes('id="what"'));
});
```

- [ ] **Step 2: Replace the decode browser logic.** Remove `decodeSlot`, `decodeCalldata`, and `initDecoding`. Add the glue below. **Verify the exact `viem`/`whatsabi` esm.sh APIs at implementation time** (run the page in a browser) — adapt names if the import shape differs; the current file already imports whatsabi as `const { loaders } = await import('https://esm.sh/@shazow/whatsabi')`.
```js
const RAW_RPC = u => window.ethereum.request(u); // signing uses the wallet provider

async function resolveSignature(selector) {
  try {
    const { loaders } = await import('https://esm.sh/@shazow/whatsabi');
    const lookup = new loaders.SamczsunSignatureLookup(); // openchain.xyz; falls back gracefully
    const sigs = await lookup.loadFunctions(selector);
    return sigs && sigs.length ? sigs : [];
  } catch { return []; }
}

async function tokenMeta(addr) {
  // symbol() = 0x95d89b41, decimals() = 0x313ce567
  try {
    const { decodeAbiParameters } = await import('https://esm.sh/viem');
    const symHex = await RAW_RPC({ method: 'eth_call', params: [{ to: addr, data: '0x95d89b41' }, 'latest'] });
    const decHex = await RAW_RPC({ method: 'eth_call', params: [{ to: addr, data: '0x313ce567' }, 'latest'] });
    let symbol; try { [symbol] = decodeAbiParameters([{ type: 'string' }], symHex); }
    catch { symbol = null; } // some tokens (e.g. MKR) return bytes32 — leave null, caller shows address
    const [decimals] = decodeAbiParameters([{ type: 'uint8' }], decHex);
    return { symbol, decimals: Number(decimals) };
  } catch { return { symbol: null, decimals: 18 }; }
}

async function decodeArgs(signature, data) {
  const { decodeFunctionData } = await import('https://esm.sh/viem');
  const abi = [ /* parseAbiItem */ (await import('https://esm.sh/viem')).parseAbiItem('function ' + signature) ];
  const { args } = decodeFunctionData({ abi, data });
  return (args || []).map(a => typeof a === 'bigint' ? a.toString() : a);
}

function showWhat(title, fields) {
  if (title) document.getElementById('headline').textContent = title;
  const el = document.getElementById('what');
  el.style.display = 'block';
  el.innerHTML = fields.map(f =>
    '<div class="decode-row"><span class="decode-key">' + esc(f.label) + '</span>' +
    '<span class="decode-val" style="' + (f.danger ? 'color:#fca5a5' : '') + '">' + esc(f.value) + '</span></div>'
  ).join('');
}
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

async function renderWhatThisDoes() {
  document.getElementById('headline').textContent = awsPlaceholderTitle(REQUEST._type);
  if (REQUEST._type !== 'sendTransaction') return; // typed-data/personal handled in Task 5
  const { to, data, value } = REQUEST;
  if (!data || data.length < 10) { // native send
    if (to) { const sym = (CHAIN_META[REQUEST.chainId]||{}).symbol || 'ETH';
      showWhat('Send ' + awsFormatAmount(BigInt(value||'0x0').toString(), 18) + ' ' + sym + ' to ' + awsTrunc(to),
               [{label:'To', value: to}, {label:'Amount', value: awsFormatAmount(BigInt(value||'0x0').toString(),18)+' '+sym}]); }
    return;
  }
  // Task 4 inserts the ERC-7730 descriptor attempt HERE (before signature decode).
  const selector = data.slice(0, 10);
  const sigs = await resolveSignature(selector);
  if (!sigs.length) { showWhat(null, [{label:'Call', value:'Unknown function ' + selector + ' — confirm in your wallet'}]); return; }
  const signature = typeof sigs[0] === 'string' ? sigs[0] : (sigs[0].name || sigs[0]);
  let args = [];
  try { args = await decodeArgs(signature, data); } catch { showWhat(null, [{label:'Call', value: signature + ' (could not decode args — confirm in your wallet)'}]); return; }
  const { name } = awsParseSignature(signature);
  let meta = {};
  if ((name === 'transfer' || name === 'transferFrom' || name === 'approve') && to) meta = await tokenMeta(to);
  const desc = awsDescribeCall({ signature, args, symbol: meta.symbol, decimals: meta.decimals });
  if (desc) { showWhat(desc.title, desc.fields); return; }
  showWhat('Calls ' + name + '()', awsParseSignature(signature).types.map((t,i) => ({ label: t, value: String(args[i] ?? '?') })));
}
```

- [ ] **Step 3: Wire into init.** In the init block, replace the `renderSummary(); initDecoding();` calls so `renderSummary()` still renders the technical summary table (chain/to/value), and `renderWhatThisDoes()` runs in place of `initDecoding()`. (Keep `renderSummary` but ensure it no longer depends on `label`/`description`.) `renderWhatThisDoes()` should be called and its promise ignored (it updates the DOM as it resolves), wrapped so a throw can't break the page: `renderWhatThisDoes().catch(()=>{})`.

- [ ] **Step 4: Verify structure + no regression.** `node --check bin/index.js`; `node --test` (all pass; the Task 3 structure test passes). Browser behavior is verified in Task 7.

- [ ] **Step 5: Commit.**
```bash
git add bin/index.js test/html.test.js
git commit -m "feat: signature-resolved semantic decode in the signer page"
```

---

## Task 4: ERC-7730 descriptor layer (LIVE-VERIFIED)

**Files:** Modify `bin/index.js` (`buildHtml` script).

> Browser code, live-verified. The registry index shape is confirmed at implementation time; if a descriptor can't be resolved or applied, fall through to the Task 3 signature decode.

- [ ] **Step 1: Add descriptor fetch + apply.** Add to the page script:
```js
async function fetchDescriptor(chainId, to) {
  try {
    const idx = await (await fetch(awsDescriptorIndexUrl('calldata'))).json();
    // The index maps deployments to descriptor paths. Find the entry whose
    // deployment matches (chainId, to). Confirm the exact index shape against
    // the live file and adapt this matcher accordingly.
    const path = findDescriptorPath(idx, chainId, to.toLowerCase());
    if (!path) return null;
    const base = 'https://raw.githubusercontent.com/ethereum/clear-signing-erc7730-registry/master/registry/';
    return await (await fetch(base + path)).json();
  } catch { return null; }
}
function findDescriptorPath(idx, chainId, to) {
  // Defensive: support a few plausible index shapes; return null if none match.
  try {
    if (Array.isArray(idx)) {
      const hit = idx.find(e => String(e.chainId) === String(chainId) && (e.address||'').toLowerCase() === to);
      return hit && (hit.path || hit.file) || null;
    }
    const byChain = idx[String(chainId)] || idx[chainId];
    if (byChain && (byChain[to] || byChain[to.toLowerCase()])) return byChain[to] || byChain[to.toLowerCase()];
  } catch {}
  return null;
}
async function applyDescriptor(descriptor, data) {
  try {
    const { decodeFunctionData } = await import('https://esm.sh/viem');
    const abi = descriptor.context && descriptor.context.contract && descriptor.context.contract.abi;
    if (!abi) return null;
    const { functionName, args } = decodeFunctionData({ abi, data });
    const formats = (descriptor.display && descriptor.display.formats) || {};
    const fmt = formats[functionName] || formats[data.slice(0,10)];
    if (!fmt) return null;
    const fields = (fmt.fields || []).map(f => {
      const val = resolvePath(args, f.path);
      return { label: f.label || f.path, value: awsFormatDescriptorField(f.format, val, f.params || {}) };
    });
    return { title: fmt.intent || functionName, fields };
  } catch { return null; }
}
function resolvePath(args, path) {
  // Minimal path resolution for "#.field" / "field" / index access; fall back to raw.
  if (path == null) return '';
  const key = String(path).replace(/^#\.?/, '');
  if (args && typeof args === 'object' && key in args) return args[key];
  const n = Number(key); if (Number.isInteger(n) && Array.isArray(args)) return args[n];
  return Array.isArray(args) ? args.join(', ') : String(args);
}
```

- [ ] **Step 2: Slot the descriptor attempt into the pipeline.** In `renderWhatThisDoes`, at the marked spot (before signature decode, after the native-send branch), add:
```js
  try {
    const descriptor = await fetchDescriptor(REQUEST.chainId, to);
    if (descriptor) { const applied = await applyDescriptor(descriptor, data); if (applied) { showWhat(applied.title, applied.fields); return; } }
  } catch {}
```

- [ ] **Step 3: Verify.** `node --check bin/index.js`; `node --test` (no regression). Behavior verified in Task 7 against a contract that has a real descriptor.

- [ ] **Step 4: Commit.**
```bash
git add bin/index.js
git commit -m "feat: ERC-7730 descriptor layer for known protocols"
```

---

## Task 5: signTypedData & personal_sign rendering (LIVE-VERIFIED)

**Files:** Modify `bin/index.js` (`buildHtml` script).

- [ ] **Step 1: Render typed data / message.** Extend `renderWhatThisDoes` for the non-transaction branches (replace the early `return` for `REQUEST._type !== 'sendTransaction'`):
```js
  if (REQUEST._type === 'personalSign') {
    showWhat('Sign message', [{ label: 'Message', value: REQUEST.message }]);
    return;
  }
  if (REQUEST._type === 'signTypedData') {
    const td = REQUEST.typedData || {};
    // Try an ERC-7730 eip712 descriptor first (verify index shape live); else pretty-print.
    try {
      const idx = await (await fetch(awsDescriptorIndexUrl('eip712'))).json();
      const vc = td.domain && td.domain.verifyingContract;
      const path = vc ? findDescriptorPath(idx, REQUEST.chainId, String(vc).toLowerCase()) : null;
      if (path) { /* fetch + apply analogous to calldata; on any failure fall through */ }
    } catch {}
    const rows = Object.entries(td.message || {}).map(([k,v]) =>
      ({ label: k, value: typeof v === 'object' ? JSON.stringify(v) : String(v) }));
    showWhat('Sign ' + (td.primaryType || 'typed data'), rows.length ? rows : [{label:'Type', value: td.primaryType || '(unknown)'}]);
    return;
  }
```

- [ ] **Step 2: Verify.** `node --check bin/index.js`; `node --test`. Browser-verified in Task 7.

- [ ] **Step 3: Commit.**
```bash
git add bin/index.js
git commit -m "feat: render typed-data and personal_sign content from data"
```

---

## Task 6: Docs

**Files:** Modify `skills/wallet-signer/SKILL.md`, `README.md`.

- [ ] **Step 1: SKILL.md.** Remove `label` and `description` from the request schema and all examples. Add a short note: "You do not (and cannot) attach a human description — the signer page shows the user what the transaction actually does, decoded from its data (ERC-7730 clear-signing where available, otherwise function/▸token decoding). Make the on-chain fields correct and let the page speak for itself." Keep examples valid (drop the `label` keys).

- [ ] **Step 2: README.md.** In the request-format section, remove `label`/`description`; add one line that the page derives a plain-English summary from the transaction data and that the user should always confirm in their wallet.

- [ ] **Step 3: Verify + commit.** `node --test` (docs don't affect tests). 
```bash
git add skills/wallet-signer/SKILL.md README.md
git commit -m "docs: drop label/description; document data-derived clear-signing summary"
```

---

## Task 7: Live fixture verification (browser)

**Files:** none (manual/interactive, like prior e2e). This is where Tasks 3–5 are actually validated.

- [ ] **Step 1:** Launch the signer for several fixtures and open each in a browser with a wallet, confirming the "What this does" headline/fields and graceful fallback:
  - **Native send** (Sepolia): `{"chainId":11155111,"to":"0xd8dA…6045","value":"0x2386f26fc10000"}` → "Send 0.01 ETH to 0xd8dA…6045".
  - **ERC-20 transfer**: a `transfer(address,uint256)` calldata to a known token (e.g. USDC on mainnet) → "Send N USDC to 0x…".
  - **Unlimited approve**: `approve(spender, 2^256-1)` → red "UNLIMITED" flag.
  - **setApprovalForAll(operator,true)** → red "transfer ALL your NFTs" flag.
  - **ERC-7730-covered call**: a method on a contract present in the registry → protocol intent string.
  - **Undecodable blob**: random `data` → "Unknown function … confirm in your wallet" (no crash, sign still available).
  - **personal_sign** and **signTypedData** fixtures → message text / typed-data tree shown.
- [ ] **Step 2:** Confirm offline/degraded behavior: with network blocked to esm.sh/registry, the page still loads, the technical summary shows, and signing still works (raw fallback).
- [ ] **Step 3:** Note any decode bugs found and fix in `bin/index.js` (committing fixes), re-verifying.

---

## Self-Review Notes (reconciled)

- **Spec coverage:** label/description removal (Task 1, 6); data-derived headline (Task 1, 2); ERC-7730 layer (Task 4); resolved-signature + 4byte/openchain semantic layer (Task 3, via whatsabi `SamczsunSignatureLookup`); generic + raw fallback (Task 3); unlimited/approve-all flags (Task 2 `awsDescribeCall`); typed-data/personal_sign (Task 5); viem/whatsabi from esm.sh, registry fetch, graceful degradation (Tasks 3–5); escaping (Task 3 `esc`/`awsTrunc`); no trust banner (omitted by design); testing split pure-vs-live (Tasks 2 vs 7); docs (Task 6). All covered.
- **Naming consistency:** `aws*` pure helpers defined in Task 2 and consumed by name in Tasks 3–5; `renderWhatThisDoes`, `showWhat`, `esc`, `fetchDescriptor`, `findDescriptorPath`, `applyDescriptor`, `resolvePath`, `tokenMeta`, `resolveSignature`, `decodeArgs` used consistently.
- **Known live-verification points (not placeholders — real reference code to confirm against live APIs):** exact `whatsabi` signature-lookup export; `viem` `parseAbiItem`/`decodeFunctionData` shapes; the registry `index.calldata.json` / `index.eip712.json` JSON structure (the `findDescriptorPath` matcher is defensive across plausible shapes). These are browser-runtime facts confirmed in Task 7.
```
