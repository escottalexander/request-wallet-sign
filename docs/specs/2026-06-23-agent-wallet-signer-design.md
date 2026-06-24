# agent-wallet-signer — Design Spec

**Date:** 2026-06-23  
**Status:** Approved

---

## Overview

`agent-wallet-signer` is a standalone `npx` utility that lets AI agents surface wallet signing requests to users via a local browser page. Instead of holding a private key, the agent passes a fully-constructed transaction as a CLI argument. A local HTTP server serves a browser page pre-populated with the transaction details; the user connects their browser wallet extension (MetaMask, Rabby, Coinbase Wallet, etc.), reviews the decoded transaction, and approves. The wallet signs and broadcasts automatically. The resulting hash is returned to the agent via stdout.

Primary use case: hacked wallet recovery — the agent constructs an EIP-7702 recovery transaction and surfaces it for the user to sign with their safe wallet, without the agent ever holding a private key.

Designed to be general-purpose: any agent needing a user wallet signature can use it.

---

## Architecture

### Single-file design

The entire CLI is one Node.js file (`bin/index.js`) with **no runtime npm dependencies**. The browser page HTML/JS is embedded as a template string inside the CLI. No build step, no `dist/` folder. The npm package ships as two files: `bin/index.js` and `package.json`.

### Request flow

```
Agent
  │
  ├─ npx agent-wallet-signer '<request JSON>'
  │
  ▼
CLI (bin/index.js)
  ├─ Parse request JSON from argv
  ├─ Start HTTP server on random available port
  ├─ Open browser → http://localhost:PORT
  ├─ Serve HTML at GET /  (request data baked into HTML response)
  └─ Wait for POST /result
        │
        ▼
   Browser page
     ├─ Load request data from page (server-rendered into HTML)
     ├─ Import whatsabi from esm.sh CDN
     ├─ Decode transaction calldata (best-effort)
     ├─ Detect window.ethereum
     ├─ User clicks "Connect Wallet"
     ├─ eth_requestAccounts → wallet_switchEthereumChain (if needed)
     ├─ eth_estimateGas / fee estimation (if not provided)
     ├─ eth_sendTransaction / eth_signTypedData_v4 / personal_sign
     └─ POST { hash | signature } → /result
        │
        ▼
CLI receives result
  ├─ Print JSON to stdout
  └─ Exit 0
```

On failure (user rejects, timeout, no wallet), CLI prints error to stderr and exits 1.

---

## CLI Interface

### Invocation

```bash
npx agent-wallet-signer [--tunnel] '<request JSON>'
```

The full request is passed as a single JSON string argument.

### Flags

- `--tunnel` — **Required to sign on another device.** Exposes the page over a public HTTPS URL via a Cloudflare quick tunnel (`npx -y cloudflared`, auto-downloaded, no account). Mobile wallet browsers only inject `window.ethereum` over HTTPS, so the default `http://localhost` / `http://LAN-IP` address fails on a phone. The tunnel is verified reachable before use (re-requested up to 3× if a free hostname is a dud) and torn down on exit. Opt-in because it makes the page publicly reachable by anyone holding the random URL.
- `--help`, `-h` — Print usage.

### Timeout

Default 5-minute timeout. If the user does not sign within that window, the CLI exits 1 with `"timeout: user did not respond"` on stderr. The timeout resets when the browser page loads (so the clock starts from when the user actually opens the page, not when the command is run).

### Stdout / exit codes

| Outcome | stdout | exit code |
|---------|--------|-----------|
| `sendTransaction` success | `{"hash":"0x...","chainId":1}` | 0 |
| `signTypedData` / `personalSign` success | `{"signature":"0x...","chainId":1}` | 0 |
| User rejected | — | 1 (stderr: rejection message) |
| No wallet detected | — | 1 (stderr: "no wallet detected") |
| Timeout | — | 1 (stderr: "timeout: user did not respond") |
| Invalid request JSON | — | 1 (stderr: parse error) |

---

## Request Format

Operation type is inferred from the shape of the JSON — no explicit `type` field required. Priority when fields overlap: `typedData` → `eth_signTypedData_v4`; `message` → `personal_sign`; otherwise → `eth_sendTransaction`.

### `eth_sendTransaction` (has `chainId` + `to` or `data`, no `typedData`/`message`)

```json
{
  "label": "Execute wallet recovery",
  "description": "Transfers all assets from your compromised wallet to your safe wallet.",
  "chainId": 1,
  "to": "0x...",
  "data": "0x...",
  "value": "0x0",
  "gas": "0x30d40",
  "maxFeePerGas": "0x...",
  "maxPriorityFeePerGas": "0x..."
}
```

- `to` is omitted for contract deployments.
- `gas`, `maxFeePerGas`, and `maxPriorityFeePerGas` are optional — estimated by the browser if absent (see Gas Estimation).
- `gasPrice` is not supported. Only EIP-1559 (type 2) transactions.
- `value` defaults to `"0x0"` if omitted.
- `label` and `description` are optional but recommended — shown on the page.

### `eth_signTypedData_v4` (has `typedData`)

```json
{
  "label": "Sign recovery intent",
  "chainId": 1,
  "typedData": {
    "domain": { "name": "...", "version": "1", "chainId": 1, "verifyingContract": "0x..." },
    "types": { "MyType": [{ "name": "foo", "type": "address" }] },
    "primaryType": "MyType",
    "message": { "foo": "0x..." }
  }
}
```

### `personal_sign` (has `message`)

```json
{
  "label": "Confirm ownership",
  "chainId": 1,
  "message": "I authorize this recovery"
}
```

---

## Gas Estimation (browser-side)

When `gas`, `maxFeePerGas`, or `maxPriorityFeePerGas` are absent, the browser estimates them before calling the wallet:

1. **`gas`** — calls `eth_estimateGas` with the transaction params, adds a 20% buffer.
2. **`maxPriorityFeePerGas`** — calls `eth_maxPriorityFeePerGas`.
3. **`maxFeePerGas`** — fetches the latest block (`eth_getBlockByNumber("latest", false)`), reads `baseFeePerGas`, computes `baseFeePerGas * 2 + maxPriorityFeePerGas`.

All RPC calls go through `window.ethereum` (the connected wallet's provider), so they target the chain the wallet is currently connected to — by the time estimation runs, the chain switch has already been confirmed.

---

## Browser UI States

The page has four states:

### 1. Ready to connect
- Shows `label` (bold heading) and `description`
- Shows transaction summary: chain name, `to` address (truncated), `value`
- Shows decoded calldata via whatsabi (see Transaction Decoding)
- Single "Connect Wallet" button

### 2. Wrong chain
- Button changes to "Switch to [Chain Name]"
- On click: calls `wallet_switchEthereumChain`; if chain unknown to wallet, calls `wallet_addEthereumChain` with the chain's public RPC
- On success, proceeds to sign

### 3. Waiting for signature
- Button shows spinner + "Check your wallet…"
- Page is inert — no double-submit possible

### 4. Done / Error
- **Success:** shows hash, block explorer link ("View on Etherscan"), "You can close this tab"
- **Error/rejection:** shows the error message clearly, offers a "Try again" button that resets to state 1

### No wallet detected
- If `window.ethereum` is absent on page load, shows:  
  "No wallet extension detected. Install MetaMask, Rabby, or another browser wallet and reload."
- No connect button rendered.

---

## Transaction Decoding

Uses whatsabi loaded from CDN:

```html
<script type="module">
  import { whatsabi } from "https://esm.sh/@shazow/whatsabi";
</script>
```

On page load, for `sendTransaction` requests:

1. Extract the 4-byte function selector from `data`
2. Use whatsabi's signature lookup (openchain.xyz) to resolve selector → function signature
3. Decode calldata arguments against the resolved signature
4. Render:
   ```
   Calling: transfer(address to, uint256 amount)
     to      0xAb58...eC9B
     amount  1000000
   ```

Graceful fallbacks (no error shown to user):
- Unknown selector → show "Unknown function (`0x12345678`)"
- No `data` field → show nothing (native transfer)
- Contract deployment (`to` absent) → show "Contract deployment (Nbytes bytecode)"
- whatsabi load failure → skip decoding entirely, show raw summary only

---

## Project Structure

```
agent-wallet-signer/
├── bin/
│   └── index.js        # CLI entrypoint — entire implementation
├── docs/
│   └── specs/
│       └── 2026-06-23-agent-wallet-signer-design.md
├── package.json
├── .gitignore
└── README.md
```

`package.json` sets `"bin": { "agent-wallet-signer": "./bin/index.js" }` so `npx agent-wallet-signer` works out of the box. Node.js built-ins used: `http`, `net` (port finding), `child_process` (open browser), `fs` (none needed — HTML is inline).

---

## Out of Scope

- EIP-7702 authorization signing (requires raw private key; browser wallets don't support it — handled separately via `cast wallet sign-authorization`)
- WalletConnect / openlv pairing (mobile signing is instead supported by serving the existing page over HTTPS via `--tunnel`)
- Multi-step sessions (one invocation = one signing request)
- Transaction simulation / revert preview
- Hardware wallet support beyond what browser extensions proxy
