# Clear Signing — Derive the Transaction Summary From Its Data

**Date:** 2026-06-24
**Status:** Approved (pending spec review)

---

## Problem

The signing page currently shows an agent-supplied `label` and `description`. These are **untrusted**: an agent could be told (or could claim) a transaction "sends 0.1 ETH to a friend" when the calldata actually grants a drainer unlimited token approval. Any human-readable summary the user relies on must come from the **transaction itself**, never from whoever requested the signature.

## Goal

Remove agent-supplied free text and render, in plain language, **what the transaction actually does**, derived only from its own data — using ERC-7730 "clear signing" descriptors where available and decoding fallbacks elsewhere. The connected wallet's own simulation/warnings (Rabby, MetaMask+Blockaid) remain the ultimate backstop.

## Non-goals

- Full transaction **simulation** of asset balance changes (Tenderly/Alchemy/Blockaid/`eth_simulateV1`). Valuable but a separate, heavier effort with new dependencies/keys.
- Exhaustive coverage of every ERC-7730 display format or every contract. Coverage is inherently partial; fallbacks carry the rest.
- NFT image/metadata rendering, fiat valuation, ENS resolution of recipients (possible later).
- No explanatory trust banner — security comes from the summary being data-derived, not from telling the user so.

---

## Request format change

`label` and `description` are **removed** from the request schema. `parseRequest` strips them if present, so no agent free text is injected into the page at all. The page headline and summary are derived entirely from the request's on-chain fields (`chainId`, `to`, `value`, `data`, `typedData`, `message`).

Everything else in the request is unchanged (`chainId`, `to`, `data`, `value`, gas/fee fields, `typedData`, `message`; operation inference is still shape-based).

---

## Decode pipeline (sendTransaction)

A layered, best-effort pipeline. Each layer is attempted in order; any failure (network, CDN, RPC, parse) falls through to the next. **Decoding never blocks or delays the ability to sign** — the technical summary and Connect button are always available; the "what this does" view fills in as decoding resolves.

1. **ERC-7730 descriptor (protocol-authored).** Fetch the registry index (`index.calldata.json`) from the GitHub registry; resolve `(chainId, to)` → descriptor path; fetch the descriptor. Decode the calldata against the descriptor's ABI and render its `intent` string + `fields`. Supported field formats (pragmatic subset; unsupported → show the raw decoded value): `raw`, `amount`/`tokenAmount` (decimals via descriptor params or `eth_call`), `addressName` (show address; name if provided), `date`, `duration`, `enum`. Partial coverage is expected — only contracts whose teams published descriptors are covered.

2. **Resolved-signature semantic render (any contract).** Resolve the 4-byte selector → function signature via `whatsabi` (which queries the [4byte](https://www.4byte.directory/) / openchain signature databases). Decode the arguments with `viem` using the resolved types. Then apply plain-English rendering keyed on the **signature**, so it works on any contract exposing standard shapes:
   - `transfer(address,uint256)` / `transferFrom(address,address,uint256)` → "Send `<amount> <SYMBOL>` to `<addr>`" (symbol/decimals via `eth_call` on the `to` token).
   - `approve(address,uint256)` → "Allow `<addr>` to spend `<amount|UNLIMITED> <SYMBOL>`"; **unlimited** (≈ uint256 max) flagged in red.
   - `setApprovalForAll(address,bool)` with `true` → "Allow `<addr>` to transfer **ALL** your NFTs in `<collection>`", flagged red.
   - Native send (no `data`) → "Send `<value>` ETH to `<addr>`".
   - Selector ambiguity (collisions): `whatsabi` returns ranked candidates; use the top and, when more than one decodes cleanly, note that the signature is ambiguous.

3. **Generic decoded call.** If the signature resolves but matches no known pattern, show the decoded `functionName(arg1, arg2, …)` with values.

4. **Raw fallback.** Unresolved selector → show the selector, byte length, and "Couldn't decode this call — confirm the details in your wallet before approving." Contract deployment (no `to`) → "Deploys a new contract (`<n>` bytes)".

### signTypedData and personal_sign

- **`signTypedData` (EIP-712):** try an ERC-7730 `eip712` descriptor (index `index.eip712.json`, keyed by `(chainId, verifyingContract)` + primary type) → render intent/fields. Otherwise pretty-print the typed-data tree (domain + message) as an escaped key/value structure — it is already structured data.
- **`personal_sign`:** display the message text verbatim (it is already human-readable). If the "message" is actually a 32-byte hash, show it as hex and note it is an opaque hash.

---

## Dependencies & failure handling

Consistent with the current posture (no bundled npm deps; browser libraries loaded from `esm.sh` at runtime, not shipped):

- **`viem`** (esm.sh) — robust ABI decoding (`decodeFunctionData`, `decodeAbiParameters`) and `formatUnits`. Keeps the ERC-7730 interpreter small.
- **`whatsabi`** (esm.sh, already used) — selector → signature via 4byte/openchain.
- **ERC-7730 registry** — descriptor JSON fetched over the network from the GitHub registry raw endpoint.

Every external call is wrapped so failure degrades to the next layer; the page must remain fully functional for signing with zero successful decode (raw fallback + the wallet's own review). The wallet (Rabby / MetaMask+Blockaid) is the real backstop and the user is expected to confirm there.

---

## UI

Remove the agent-text header and the old summary's reliance on `label`/`description`. The page shows:

1. **Headline** — the derived action (e.g. "Send 25 USDC to 0x1234…abcd"). Neutral placeholder until decode resolves: "Review transaction" / "Review message" / "Review typed-data signature".
2. **"What this does"** — the decoded intent and key fields, with red flags for **unlimited approvals** and **approve-all-NFTs**. Spinner/"decoding…" state while layers resolve; "couldn't decode — confirm in your wallet" if all fail.
3. **Technical summary** (supporting detail, as today) — chain name, `to` (copyable), value in ETH, and the decoded calldata table.
4. Connect / sign flow, copy buttons, cross-device tunnel, auto-close — all unchanged.

**Escaping:** every decoded/fetched string (token symbol, descriptor intent, resolved signature, addresses) is HTML-escaped before rendering — descriptor text and on-chain token names are themselves untrusted input.

---

## Testing

- **`node:test`** continues to cover request parsing (including that `label`/`description` are stripped), the server, and HTML **structure** (headline element, "what this does" container, escaping of injected/decoded values, absence of any `label`/`description` rendering).
- **Pure helpers** extracted and unit-tested in node: unlimited-amount detection, registry index-URL builder, `(chainId,address)`→lookup-key, headline/placeholder selection, and the field-format → display-string function (given already-decoded values, no network/DOM).
- **Decode/clear-sign browser logic** (uses `window.ethereum`, `fetch`, DOM) is verified via **live fixtures**: render against known calldata — USDC `transfer`, an `approve(MAX)` unlimited, `setApprovalForAll(…,true)`, a major-protocol call that has a real ERC-7730 descriptor (e.g. a Uniswap/Aave method), a native send, and an undecodable blob — confirming both correct output and graceful fallback when esm.sh / the registry / `eth_call` are unavailable.

Honest caveat (carried in code comments and the README): ERC-7730 coverage is **partial/registry-gated**; most arbitrary agent transactions resolve via the signature-decode and raw layers, and the wallet's own simulation remains the final safeguard.

---

## Documentation

- Update `skills/wallet-signer/SKILL.md`: remove `label`/`description` from the request schema and examples; state that the page shows the user what the transaction actually does (decoded from its data), so the agent neither needs nor can provide a human description.
- Update `README.md` and the request-format section / `HELP_TEXT` accordingly.

---

## Out of scope / future

- Real asset-change simulation (Tier 2) via `eth_simulateV1` or a sim API.
- Broader ERC-7730 format coverage and caching of the registry index.
- ENS resolution and fiat valuation of amounts.
