---
name: wallet-signer
description: >-
  Get a human to sign or send an Ethereum transaction, message, or EIP-712
  typed-data with their own browser wallet (MetaMask, Rabby, Coinbase Wallet,
  etc.) when YOU do not hold the private key. Use this whenever a task needs an
  on-chain transaction sent from the user's wallet, a `personal_sign` signature,
  or an `eth_signTypedData_v4` signature, and you cannot sign it yourself —
  e.g. "send 0.1 ETH to vitalik.eth", "approve this token", "execute this swap
  from my wallet", "sign this permit / login message", "sign this Safe / EIP-712
  payload". It opens a local browser page where the user reviews and approves;
  the signed hash or signature comes back to you on stdout. The user's key never
  leaves their wallet.
---

# wallet-signer

`agent-wallet-signer` is a CLI that surfaces a signing request to the user in a
local browser page. You pass a fully-formed request as one JSON argument; the
user connects their browser wallet, reviews the decoded details, and approves;
the wallet signs/broadcasts; you get the result back on **stdout**. You never
touch a private key.

## Invoke

```bash
npx agent-wallet-signer '<request JSON>'
```

(In this repo, equivalently: `node bin/index.js '<request JSON>'`.)

The command **blocks until the user acts** (or a 5-minute timeout). On success it
prints one line of JSON to stdout and exits `0`. On rejection / no wallet /
timeout / bad input it prints a message to stderr and exits `1`.

## Build the request

`chainId` (an **integer**, e.g. `1` mainnet, `8453` Base, `11155111` Sepolia) is
always required. You do **not** attach any human description — the page shows the
user what the transaction actually does, decoded from its data (ERC-7730
clear-signing where the contract is covered, otherwise function + token
decoding). Your job is to get the on-chain fields right; the page speaks for
itself. The **operation type is inferred from shape** — do not add a `type`
field:

- has `typedData` → `eth_signTypedData_v4`
- else has `message` → `personal_sign`
- else → `eth_sendTransaction`

All numeric on-chain fields are **hex strings** (wei, gas), not decimals.

### Send a transaction

```json
{ "chainId": 1,
  "to": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  "value": "0x2386f26fc10000" }
```

- `to`: recipient or contract. Omit `to` for a contract deployment.
- `value`: amount in **wei as hex** (default `"0x0"`). 0.01 ETH = `10^16` wei = `0x2386f26fc10000`.
- `data`: calldata hex for contract calls (e.g. an ERC-20 `transfer`/`approve`). The page decodes and shows it to the user.
- `gas`, `maxFeePerGas`, `maxPriorityFeePerGas`: **optional** hex — the page estimates them if omitted. Only EIP-1559 (type-2) is supported; do not send `gasPrice`.

Result: `{"hash":"0x…","chainId":1}`

### Sign a message (personal_sign)

```json
{ "chainId": 1, "message": "I authorize login at 2026-06-24" }
```

Result: `{"signature":"0x…","chainId":1}`

### Sign EIP-712 typed data

```json
{ "chainId": 1,
  "typedData": { "domain": {"name":"...","version":"1","chainId":1,"verifyingContract":"0x..."},
                 "types": {"Permit":[{"name":"owner","type":"address"}]},
                 "primaryType": "Permit", "message": {"owner":"0x..."} } }
```

Result: `{"signature":"0x…","chainId":1}`

## Read the result

Parse stdout as JSON. Branch on the keys, not on guesses:

```bash
out=$(npx agent-wallet-signer '<request JSON>') || { echo "user did not complete"; exit 1; }
# $out is {"hash":...} for a transaction, or {"signature":...} for a signing op
```

Exit `1` means the user rejected, had no wallet, or let it time out — surface
that to the user rather than retrying blindly.

## Signing from another device (phone, tablet, other computer)

The page opens on the machine running the command. To let the user approve on a
**different device**, that device needs an HTTPS URL (mobile wallets only inject
a provider over HTTPS). The page has a **"📱 Sign on another device"** button
that starts a Cloudflare tunnel on demand, or you can pre-start it:

```bash
npx agent-wallet-signer --tunnel '<request JSON>'      # tunnel ready on page load
npx agent-wallet-signer --stop-tunnel                  # tear down the shared tunnel
```

The tunnel is **reused across invocations**, so issuing several requests in a row
does not create many tunnels. Only reach for `--tunnel` when the user actually
needs another device; the default local flow has zero tunnel overhead.

## Good defaults

- The user sees a plain-English summary derived from the transaction data and
  confirms in their own wallet — so correctness of `to`/`data`/`value`/`chainId`
  is what matters.
- One request = one signature. For a multi-step flow (e.g. approve then swap),
  call the tool once per step and check each result before continuing.
- Don't fabricate gas/fee values; omit them and let the wallet/page estimate.
- Convert decimal amounts to hex wei before sending.
