# planner

Pings you on Telegram when a planned block of the day starts, and nudges once
if you haven't replied. It's a **den extension**: it lives in the wolf's den,
not in wolfpack core, and uses the extension `lifecycle` API.

## State

The extension reads `<den>/planner/state.json` every minute (your wolf or a
skill writes it):

```json
{
  "blocks": [
    { "time": "09:00", "slug": "deep-work", "pinged": false },
    { "time": "13:30", "slug": "review",    "pinged": false }
  ],
  "lastResponse": "2026-01-01T09:05:00Z"
}
```

`time` is 24h `HH:MM` in the configured timezone. Each block is pinged once.

## Install

Put the source in the wolf's den, in the hub's copy of it
(`<wolvesRoot>/<host>/<wolf>/den/`, e.g. `~/wolves/local/<wolf>/den/` for a
local wolf):

```sh
mkdir -p <den>/extensions/planner
cp examples/extensions/planner/index.ts <den>/extensions/planner/
```

Enable it in `wolf.yaml`:

```yaml
extensions:
  - memory
  - telegram
  - planner
planner:
  timezone: Europe/Berlin   # IANA zone for block times (default: system zone)
  nudgeAfterMinutes: 15     # default 15
```

Then `wolfpack sync <wolf>`. Sync builds `index.ts` with esbuild (bundling any
`@wolfpack/*` imports) and ships `index.js` to the host's
`<den>/extensions/planner/`. Prefer to build it yourself? Drop a ready
`index.js` next to (or instead of) `index.ts` and sync ships that as is.

Telegram must be configured: pings go to your chat, which the wolf knows once
you've written to it.
