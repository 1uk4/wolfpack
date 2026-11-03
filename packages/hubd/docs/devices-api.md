# Device management API (hubd)

Who may call what. Every route needs `Authorization: Bearer <device token>`; the identity is the token's.

| Route | console / browser token | worker token | no/bad token |
|---|---|---|---|
| `GET /v1/tokens` | 200: console/browser devices `{id,label,kind,createdAt,lastUsedAt,self}` | 403 | 401 |
| `DELETE /v1/tokens/:id` | 200 `{revoked,self}`; any console/browser device, **including itself** (sign out) | 403 | 401 |
| `POST /v1/tokens/pairing-codes` `{label?}` | 200 `{code,expiresAt}`: a single-use 10-minute **browser** code | 403 | 401 |

- Worker tokens (VPS hosts) are never listed and never revocable here (404); use `hubd tokens revoke` on the host.
- A device cannot mint `worker` or `console` codes, only browser ones (those stay operator-CLI: `hubd pair`).
- Secrets: the response never carries a token or hash; `lastUsedAt` is about 5s stale (flushed by the hub).
- Rate limit: mints plus revokes, 10 a minute per calling token, then 409 `busy` (retryable). Redeeming at `/v1/pair` keeps its own failure limiter.
- Audit: every revoke and mint logs one line (`token <caller> revoked device <id> ...` / `minted a browser pairing code`), never a secret.
- Revoking closes that device's open `/v1/events` streams within the auth poll (1s); the console's activity bridge for that device ends on the 401 and no other device is affected.
