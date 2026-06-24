# Lazy, Reusable Cloudflare Tunnel — Design Spec

**Date:** 2026-06-24
**Status:** Approved (pending spec review)

---

## Problem

The current `--tunnel` implementation has two issues surfaced in testing:

1. **Intolerable upfront wait.** Establishing + verifying a tunnel blocks the CLI for up to ~2.5 minutes before the page is usable.
2. **Throttling.** A fresh Cloudflare quick tunnel is created per invocation. Signing many transactions in a short window creates many tunnels, and Cloudflare rate-limits free quick-tunnel DNS provisioning from the IP (every new hostname returns NXDOMAIN).

## Goals

- **Zero overhead for local-only users** (the ~90% case). The default `agent-wallet-signer '<json>'` invocation must behave exactly as today: instant local page, no state file, no `cloudflared`, no waiting.
- **No blocking wait** for cross-device: the page is served immediately; the tunnel starts on demand.
- **Reuse one tunnel across many invocations** so repeated transactions don't re-create tunnels → defeats the throttling at its root.
- **User-triggered verification**, not a blocking probe.
- **Clean teardown**: idle TTL + explicit stop command.

## Non-goals

- Concurrent cross-device signing sessions (sequential is the supported path; concurrency degrades gracefully — see Limitations).
- QR code rendering (possible later enhancement; out of scope here).
- A long-lived daemon / request broker (rejected as too much machinery for a single-file tool).

---

## Approach: lazy tunnel + persistent `cloudflared` + state file

The tunnel lifecycle is decoupled from a single signing request. A small state file tracks one long-lived `cloudflared` process that successive invocations reuse.

### Stable "tunnelable" port

`cloudflared` proxies to a fixed local port, so for reuse to work the signing server must listen on that same port.

- At startup the server attempts to bind a **deterministic preferred port** (constant, e.g. `8456`).
  - **Free →** bind it. This session is "tunnel-capable": its port matches the canonical tunnel target.
  - **Busy →** bind a random port (today's behavior). The session still works fully locally; cross-device may start its own tunnel rather than reuse.
- Binding a deterministic port is invisible to local-only users — no files, no processes. State is created **only when a tunnel is actually started.**

Between sequential transactions no server holds port `8456`, so it is free for the next invocation to bind; `cloudflared` keeps running and routes to whichever server currently holds the port (returning 502 in the gap, which is fine — nothing is loading it then).

### State file `~/.agent-wallet-signer/state.json`

```json
{ "port": 8456, "url": "https://x.trycloudflare.com", "pid": 12345,
  "startedAt": <epoch ms>, "lastUsedAt": <epoch ms> }
```

Created on first tunnel start; updated (`lastUsedAt`) on reuse. Local-only users never create it.

### Tunnel decision logic (pure, unit-tested)

`decideTunnelAction(state, port, now)` → one of:

- **`reuse`** — `state` exists, `pid` is alive, `now - lastUsedAt < TTL`, and `state.port === port`. Return existing `url`.
- **`replace`** — `state` exists but is stale (`> TTL`) or `pid` dead. Kill any live pid, then start fresh.
- **`start`** — no usable `state`. Start fresh.

`TTL = 10 minutes`. Liveness checked with `process.kill(pid, 0)`.

### `cloudflared` lifecycle

- Started **detached** (`spawn(..., { detached: true })`), stdout/stderr piped only long enough to scrape the `https://*.trycloudflare.com` URL, then `unref()`ed so it survives CLI exit.
- On CLI exit the tunnel is **not** killed (that is what enables reuse).
- Reaped by: (a) the next invocation finding it stale (> TTL) and killing it, (b) explicit `--stop-tunnel`, or (c) reboot. Documented so the lingering process is expected, not surprising.

---

## Server endpoints

Added to the existing server (which still serves `GET /` and `POST /result`):

- **`POST /tunnel/start`** — run `decideTunnelAction`; reuse or start a tunnel; respond `{ "url": "https://…" }` or `{ "error": "throttled" }` (could not confirm / produce a URL).
- **`POST /tunnel/check`** — server-side single-shot probe of the current tunnel URL; respond `{ "reachable": true|false }`. (Server-side avoids browser CORS issues and reuses the existing reachability fetch.)

---

## CLI interface

```bash
agent-wallet-signer '<request JSON>'          # local; lazy cross-device button in page
agent-wallet-signer --tunnel '<request JSON>' # pre-warm: auto-start tunnel on page load
agent-wallet-signer --stop-tunnel             # kill tracked cloudflared, delete state, exit
```

- **default** — unchanged local flow. The page additionally shows a dormant *"📱 Sign on another device"* button (no tunnel until clicked).
- **`--tunnel`** — the page auto-invokes `/tunnel/start` on load (same code path as the button). No blocking in the CLI; status reflected in the page. Useful for agents that already know they need cross-device.
- **`--stop-tunnel`** — maintenance command; takes no request JSON.

---

## Browser UI

The connectivity area becomes interactive:

1. Default: a single *"📱 Sign on another device"* button.
2. On click (or auto, with `--tunnel`): button → spinner *"Starting secure tunnel…"*, then POST `/tunnel/start`.
3. **Success:** show the `🌎` tunnel URL (with copy button) + a *"Check reachability"* button (→ `POST /tunnel/check`, shows ✓ / ⚠ retry) + the `📱 Same network` LAN URL as a secondary option.
4. **Throttled / error:** show the amber caveat (tunnel throttled, retry later) + the LAN URL.

Signing logic, transaction summary, calldata decoding, auto-close, automatic chain switching, ETH formatting, and copy buttons are unchanged.

---

## What stays the same

`parseRequest`, operation inference, signing (`eth_sendTransaction` / `eth_signTypedData_v4` / `personal_sign`), gas/fee estimation with graceful fallback, the 5-minute timeout, stdout/exit-code contract, automatic network switching, auto-close, and the LAN-address display.

---

## Testing

- **Unit (pure):** `decideTunnelAction(state, port, now)` across reuse / replace / start; `parseOptions` for `--tunnel` and `--stop-tunnel`; state-file serialize/parse; `buildHtml` shows the "Sign on another device" button and (when given a tunnel URL) the tunnel section.
- **Live (manual):** lazy start from button, reuse across two sequential invocations (same URL, no second tunnel), `--stop-tunnel`, throttled fallback to LAN + caveat.

---

## Limitations (documented)

- **Concurrency:** two simultaneous cross-device sessions can't share port `8456`; the second binds a random port and may start its own tunnel, overwriting `state` (last-writer-wins) and orphaning the other `cloudflared` until reboot or `--stop-tunnel`. The common sequential case is clean.
- **Lingering process:** a reused `cloudflared` stays running between invocations by design. Bounded by the idle TTL (reaped on the next run) and `--stop-tunnel`.
- **Hardcoded port `8456`:** if another app holds it, reuse is skipped and a random port is used (still fully functional, just no shared tunnel that round).
