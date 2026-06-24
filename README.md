# agent-wallet-signer

A standalone `npx` utility that lets AI agents surface wallet signing requests to a user via a local browser page. The agent passes a fully-constructed transaction as a CLI argument; a local HTTP server serves a browser page pre-populated with the details. The user connects their browser wallet (MetaMask, Rabby, Coinbase Wallet, …), reviews the decoded transaction, and approves. The wallet signs/broadcasts, and the resulting hash or signature is returned to the agent on stdout.

The agent never holds a private key.

## Usage

```bash
npx agent-wallet-signer '<request JSON>'
```

```bash
# Sign from another device (phone, tablet, another computer):
npx agent-wallet-signer --tunnel '<request JSON>'
```

On success, prints `{"hash":"0x…","chainId":N}` (or `{"signature":"0x…","chainId":N}`) to stdout and exits 0. On rejection, missing wallet, or a 5-minute timeout, prints to stderr and exits 1.

## ⚠️ Signing on another device requires `--tunnel`

> **If the user wants to sign on a different device than the one running the command, you MUST pass `--tunnel`.**

By default the page is served over `http://localhost:<port>` (and the LAN address `http://<ip>:<port>`). Mobile wallet in-app browsers only inject a wallet provider (`window.ethereum`) over a **real HTTPS origin**, so a plain `http://` LAN address will silently fail to connect on a phone.

`--tunnel` solves this by spawning [`cloudflared`](https://www.npmjs.com/package/cloudflared) via `npx` (auto-downloaded on first run, **no Cloudflare account needed**) to expose the page on a public `https://*.trycloudflare.com` URL. That HTTPS URL is printed to stderr and shown in the page; open it inside the **wallet app's built-in browser** on the other device.

**Security note:** `--tunnel` makes the signing page publicly reachable by anyone who has the (unguessable, random) URL — they can see the transaction details, though they cannot sign without the user's wallet. It is therefore strictly opt-in. The tunnel is torn down automatically when the command exits.

## Request format

Operation type is inferred from the JSON shape (no `type` field). Priority: `typedData` → `message` → transaction.

```jsonc
// eth_sendTransaction
{ "label": "Send funds", "description": "…", "chainId": 1,
  "to": "0x…", "data": "0x…", "value": "0x0",
  "gas": "0x…", "maxFeePerGas": "0x…", "maxPriorityFeePerGas": "0x…" }

// eth_signTypedData_v4
{ "label": "…", "chainId": 1, "typedData": { "domain": {}, "types": {}, "primaryType": "…", "message": {} } }

// personal_sign
{ "label": "…", "chainId": 1, "message": "I authorize this" }
```

- `to` omitted → contract deployment. `value` defaults to `"0x0"`.
- `gas` / `maxFeePerGas` / `maxPriorityFeePerGas` optional — estimated browser-side (EIP-1559 / type-2 only). Fee estimation degrades gracefully if the wallet's RPC lacks `eth_maxPriorityFeePerGas`.
- `label` / `description` optional but recommended — shown to the user.

## Behavior

- Browser opens automatically on the machine running the command.
- The page shows a transaction summary (chain name, recipient, value in ETH), decoded calldata (best-effort via whatsabi), and copy buttons (copy recipient, copy network/tunnel URL, copy full tx data).
- On success the tab attempts to auto-close.
- 5-minute timeout, measured from launch.

## Run the tests

```bash
npm test
```
