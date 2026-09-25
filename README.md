# @pipeworx/pulse-verity

Crypto index prices that come with a **proof**. Every observation from the Pulse
Verity Index is signed with ECDSA P-256, so an agent that acted on a price can
later demonstrate exactly which price it acted on — and that demonstration holds
with the agent, the gateway and Pulse all offline.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

This is the first source in the catalogue that hands back something checkable.
Every other price feed here gives you a number you must take on trust.

## Tools

- `pulse_signed_price(symbol)` — current signed print for one asset.
- `pulse_signed_batch(symbols[])` — up to 100 assets in one call, each row
  individually signed. Symbols Pulse does not serve are named in `not_served`
  rather than silently dropped.
- `pulse_settlement_print(symbol, at)` — the signed print Pulse **recorded**
  nearest a past moment, plus `delta_ms`. For settling contracts and
  reconstructing a price at a timestamp.
- `pulse_verify_print(print)` — check a print. Returns `valid: true|false`.
- `pulse_asset_catalog(limit?, offset?, band?, status?)` — coverage and measured
  cadence across 6,700+ observed assets. **Unsigned** (see below).
- `pulse_key_ring()` — the public keys, algorithm and canonical format. Keyless.

## Auth

A **platform key** is wired (`PLATFORM_PULSE_KEY`), so callers need no key of
their own. `_apiKey` is still accepted for anyone bringing theirs.

**The key lives in the encrypted `platform_keys` KEYSTORE, not in a Cloudflare
secret binding** — `scripts/pwcall.sh platform-key-put PLATFORM_PULSE_KEY < file`
(fleet #2007, `docs/platform-key-store-plan.md`). Do **not** reach for
`wrangler secret put` for a new key here: the gateway sits one binding under
Cloudflare's 250-text-binding ceiling, and a `check-gateway-bindings` gate
blocks the deploy for EVERY lane the moment the secret count rises above its
committed baseline. This pack was built that way by mistake first and reddened
the gateway deploy until the key was moved into the keystore and the individual
binding deleted; `scripts/pwcall.sh platform-key-status` should show
`binding_underneath: false` for it.

Free and self-serve at <https://thepulse.markets/developers>: 60 requests a
minute, 25,000 a month, no card. `pulse_verify_print` and `pulse_key_ring` need
no key at all. The keyless `/sample` endpoint upstream covers only BTC/ETH/SOL;
everything wider needs the key.

## How verification works, and what "local" means

Canonical string, signed with ECDSA P-256 / SHA-256, signature as IEEE-P1363
`r||s` in base64:

```
pulse-index-v1\n{symbol}\n{priceText}\n{at}\n{grade}
```

`pulse_verify_print` recomputes this in the worker. **Pulse is never asked
whether a print is valid**, so Pulse cannot vouch for a print it did not sign,
and an offline or compromised source cannot turn an invalid print into a valid
one. What is *not* local is key distribution: a `kid` we have not seen before
costs one fetch of the public ring, which is then cached. Every response says
which happened in `key_source`, because "verified locally" is a security claim
and should not be made vaguely.

Verified live 2026-09-16, independently of Pulse's own code, with tamper
controls — a verifier that only ever returns `true` proves nothing:

| input | `valid` |
|---|---|
| the print as returned | **true** |
| price + 1 | false |
| grade changed | false |
| `at` shifted by 1 ms | false |
| symbol swapped | false |
| `kid` not in the ring | throws, and says treat the print as UNVERIFIED, not invalid |

### The `priceText` trap

The canonical string uses `priceText` — the price **exactly as it came off the
wire** — never a reparsed float. On the sample used while building this,
`String(price)` happened to equal `priceText`, so a float-reparsing verifier
verified correctly and looked right. It breaks the first time JS number
formatting diverges from the wire text: a trailing zero, exponent form, or more
than 17 significant digits. A verifier that is correct only until the price has
a trailing zero is worse than none, because it will be trusted.

This pack prefers `priceText` and falls back to `String(price)` only when
`priceText` is absent — Pulse's own documented fallback — and says so in
`price_field_used`, with a warning when the fallback is used.

## Grades are load-bearing

| grade | venues | settleable |
|---|---|---|
| `consensus` | 3 or more independent | yes |
| `blended` | 2 | yes |
| `indicative` | 1 exact-mapped | **no** |

Pulse publishes `indicative` so a thin asset reads as thin instead of
confidently wrong. That is only honest downstream if we carry it through, so
every print this pack returns also carries a derived `settleable` boolean and a
`grade_note` spelling out the consequence — an agent reading a bare `price`
field will not infer that `indicative` disqualifies it. An unrecognised grade is
treated as **not** settleable.

## What is signed and what is not

Prints (`pulse_signed_price`, `pulse_signed_batch`, `pulse_settlement_print`)
are signed. The **asset catalogue is not**: its rows carry prices and coverage
metadata with no signature. `pulse_asset_catalog` therefore returns
`signed: false` and says so, because serving an unsigned price from a pack whose
whole pitch is signatures is the confusion most worth pre-empting.

## Gotchas

- `pulse_settlement_print` returns the **nearest recorded** print, not a price
  synthesised at your instant. Check `delta_ms` against a tolerance you state.
- Batch returns *fewer* rows than requested for unserved symbols, absent rather
  than errored. An unlisted symbol is not a price of zero — read `not_served`.
- Upstream signals refusals in-band with `success: false` and a `code`; this
  pack raises those rather than returning a body that looks like data.
- `/price` with the wrong parameter name (`symbols=` instead of `symbol=`)
  returns `UNSUPPORTED_SYMBOL` complaining about `'?'`. It is an upstream
  quirk, not a coverage answer.

## Data sources

- <https://thepulse.markets/developers> — key signup and docs
- `https://mcp.thepulse.markets/api/index/v1/price` — signed print
- `https://mcp.thepulse.markets/api/index/v1/batch` — up to 100 symbols
- `https://mcp.thepulse.markets/api/index/v1/print` — recorded print near a time
- `https://mcp.thepulse.markets/api/index/v1/verity/catalog` — coverage, unsigned
- `https://mcp.thepulse.markets/api/index/v1/pubkey` — public key ring, keyless
- `https://mcp.thepulse.markets/api/index/v1/symbols` — 5,500+ served tickers

Pulse also publishes its own MCP server (`pulse-verity` on npm,
`io.github.PulseBet/pulse-verity` in the official registry). This pack is a
separate adapter so the failure shapes, grade handling and naming match the rest
of the Pipeworx catalogue.

Relationship opened by Bruce with Justin (founder) by e-mail, 2026-09-15/16.
Built as fleet #2173.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "pulse-verity": {
      "url": "https://gateway.pipeworx.io/pulse-verity/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/pulse-verity/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/pulse_signed_price \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"BTC"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/pulse_signed_price`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "pulse-verity": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-pulse-verity"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-pulse-verity
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Pulse Verity data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
