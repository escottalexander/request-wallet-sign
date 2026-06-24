# agent-wallet-signer

A standalone `npx` utility that lets AI agents surface wallet signing requests to a user via a local browser page. The agent passes a fully-constructed transaction as a CLI argument; a local HTTP server serves a browser page pre-populated with the details. The user connects their browser wallet (MetaMask, Rabby, Coinbase Wallet, …), reviews the decoded transaction, and approves. The wallet signs/broadcasts, and the resulting hash or signature is returned to the agent on stdout.

The agent never holds a private key.

## Usage

```bash
npx agent-wallet-signer '<request JSON>'
```

```bash
# Sign from another device (phone, tablet, another computer):
# Click the "📱 Sign on another device" button in the page, or pre-start the
# tunnel on page load with --tunnel:
npx agent-wallet-signer --tunnel '<request JSON>'
```

On success, prints `{"hash":"0x…","chainId":N}` (or `{"signature":"0x…","chainId":N}`) to stdout and exits 0. On rejection, missing wallet, or a 5-minute timeout, prints to stderr and exits 1.

## Signing on another device

The default invocation is **local-only** — instant page, no tunnel, no background processes, no state files.

To sign from a phone, tablet, or another computer, the page has a **"📱 Sign on another device"** button. Clicking it starts (or reuses) a [Cloudflare quick tunnel](https://www.npmjs.com/package/cloudflared) via `npx` (auto-downloaded on first run, **no Cloudflare account needed**) and shows a public `https://*.trycloudflare.com` URL. A **"Check reachability"** button verifies the tunnel server-side when you choose. Open the HTTPS URL inside the **wallet app's built-in browser** on the other device — cross-device needs HTTPS because mobile wallets only inject `window.ethereum` over a secure origin.

Pass `--tunnel` to pre-start the tunnel automatically on page load (handy for agents that already know they need cross-device).

**Reuse:** the tunnel is recorded in `~/.agent-wallet-signer/state.json` and **reused across invocations**, so signing many transactions in a row does not create many tunnels (which would get rate-limited by Cloudflare). It is a single shared background process, reaped after 10 minutes idle or immediately with:

```bash
npx agent-wallet-signer --stop-tunnel
```

**Security note:** an active tunnel makes the signing page reachable by anyone holding the random (unguessable) URL — they can see transaction details but cannot sign without the user's wallet. Nothing leaves your machine until you start a tunnel.

## Request format

Operation type is inferred from the JSON shape (no `type` field). Priority: `typedData` → `message` → transaction.

```jsonc
// eth_sendTransaction
{ "chainId": 1,
  "to": "0x…", "data": "0x…", "value": "0x0",
  "gas": "0x…", "maxFeePerGas": "0x…", "maxPriorityFeePerGas": "0x…" }

// eth_signTypedData_v4
{ "chainId": 1, "typedData": { "domain": {}, "types": {}, "primaryType": "…", "message": {} } }

// personal_sign
{ "chainId": 1, "message": "I authorize this" }
```

- `to` omitted → contract deployment. `value` defaults to `"0x0"`.
- `gas` / `maxFeePerGas` / `maxPriorityFeePerGas` optional — estimated browser-side (EIP-1559 / type-2 only). Fee estimation degrades gracefully if the wallet's RPC lacks `eth_maxPriorityFeePerGas`.
- The page shows the user a plain-English summary **derived from the transaction data itself** (ERC-7730 clear signing where available, otherwise decoded function + token info) — the requester cannot supply or override this text. Always confirm in your wallet.

## Behavior

- Browser opens automatically on the machine running the command.
- The page shows a transaction summary (chain name, recipient, value in ETH), decoded calldata (best-effort via whatsabi), and copy buttons (copy recipient, copy network/tunnel URL, copy full tx data).
- On success the tab attempts to auto-close.
- 5-minute timeout, measured from launch.

## Run the tests

```bash
npm test
```
