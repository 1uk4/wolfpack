# Device management API (hubd)

Who may call what. Every route needs `Authorization: Bearer <device token>`; the identity is the token's.

| Route | console / browser token | worker token | no/bad token |
|---|---|---|---|
| `GET /v1/tokens` | 200: console/browser devices `{id,label,kind,createdAt,lastUsedAt,self,addedBy,addedById}` | 403 | 401 |
| `DELETE /v1/tokens/:id[?cascade=1]` | 200 `{revoked,self,cascaded}`; any console/browser device, **including itself** (sign out); `cascade=1` also revokes the devices it added, transitively | 403 | 401 |
| `POST /v1/tokens/pairing-codes` `{label?}` | 200 `{code,expiresAt}`: a single-use 10-minute **browser** code | 403 | 401 |

- Worker tokens (VPS hosts) are never listed and never revocable here (404); use `hubd tokens revoke` on the host.
- A device cannot mint `worker` or `console` codes, only browser ones (those stay operator-CLI: `hubd pair`).
- Secrets: the response never carries a token or hash; `lastUsedAt` is about 5s stale (flushed by the hub).
- Rate limit: mints plus revokes, 10 a minute per calling token, then 409 `busy` (retryable). Redeeming at `/v1/pair` keeps its own failure limiter.
- Audit: every revoke and mint logs one line (`token <caller> revoked device <id> ...` / `minted a browser pairing code`), never a secret.
- Revoking closes that device's open `/v1/events` streams within the auth poll (1s); the console's activity bridge for that device ends on the 401 and no other device is affected.

## Provenance, cascade, last-console guard
- A code minted through the API records the calling token id (`mintedBy`) on the code and on the token it redeems into. `addedBy` is that device's label, `addedById` its id; both are `null` for `hubd pair` (CLI) tokens, for tokens that predate this field, and `addedBy` is `null` once the minter is revoked.
- Cascade follows `mintedBy` transitively and is opt-in; without it only the named device goes. Worker tokens are never part of a cascade.
- Revoking the last remaining `console`-kind token (alone or through a cascade) is refused: 409 `conflict`, nothing revoked. Check and delete happen under the token-store lock. (`hubd tokens revoke` on the host is not guarded.)
- Callers are an allowlist: only `console` and `browser` tokens; any other kind is 403.

## Event-stream budget
- The 128 cap (`maxEventStreams`) counts only the hub's own `GET /v1/events` streams (the pack event feed). The console's activity bridge does not use it: it follows each wolf with `GET /v1/wolves/:name/activity`, tunnelled by the relay, so **one open tab = one bridge = one relay stream per wolf** (a 3-wolf pack is 3 streams per tab, per device token). Those count against the relay's per-host in-flight limit (256 per worker host, 503 `busy`), not the 128.
- Either limit answering `busy` is retryable: the bridge backs off (1s, 2s, 5s, 15s, 30s, repeating) and keeps the tab's connection open; closing the tab stops it. Pinned by a console test.
- A revoked or unpaired tab is told once with an `auth-lost` SSE frame and then closed; the page stops its EventSource and goes to /pair. A connect with no token at all gets 401.
