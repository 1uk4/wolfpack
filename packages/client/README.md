# @wolfpack/client

`ConsoleClient` is the console's only view of a wolf. Two interchangeable implementations:

```ts
import { HttpConsoleClient, MockConsoleClient, type ConsoleClient } from "@wolfpack/client";

const mock: ConsoleClient = new MockConsoleClient();                       // in-process, scripted
const http: ConsoleClient = new HttpConsoleClient({ baseUrl: "http://127.0.0.1:4100" }); // any /v1 server

const [wolf] = await http.listWolves();
const [thread] = await http.listThreads(wolf.id);
await http.submit(thread.id, "hello");            // whenBusy defaults to "reject" (always sent explicitly)
for await (const ev of http.watch(thread.id)) {   // ends after turn-end
  if (ev.type === "text-delta") process.stdout.write(ev.text);
}
```

`HttpConsoleClient` options: `baseUrl`, `actor?` (reserved, not sent in v1), `fetch?` (injectable),
`maxStreamRetries?` (default 5), `retryDelayMs?` (default 50, doubles, capped 2s).
Every request carries `X-Protocol-Version`. Errors map by envelope **code**: `busy` → `BusyError`,
`not_found` → `NotFoundError`, anything else → `ProtocolError(code, message, retryable)`.

## Stream guarantees

- **Auto-resume.** If the connection drops mid-stream (fetch/body error, or EOF without `[DONE]`),
  `watch()` reconnects with `Last-Event-ID` = last yielded id, with bounded retries and backoff
  (the retry budget resets on progress). Ids `<=` the last yielded id are dropped, so consumers
  see no gaps and no duplicates. Exhausting retries throws `ProtocolError("engine_error", …, retryable: true)`.
- **Snapshot fold.** On a stale cursor the server sends a `snapshot` baseline instead of a replay.
  `watch()` never yields it: pass `onSnapshot(snapshot)` to replace local state with
  `snapshot.thread` / `snapshot.inFlight`; the cursor becomes `snapshot.upToId` and the following events continue from there.
- **Tolerance.** Unknown event types are skipped; a malformed known event throws `ProtocolError("invalid_request")`.
- **Termination.** The stream ends at the first `turn-end` (`[DONE]`).

## Testing

`src/behaviours.ts` exports `runBehaviours(label, make)`, the shared behaviour suite; it runs against
the mock (`client.test.ts`) and against `HttpConsoleClient` ↔ `StubServer` (`http.test.ts`).
Use it for any new `ConsoleClient` implementation.
