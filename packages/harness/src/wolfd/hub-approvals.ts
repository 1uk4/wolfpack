/**
 * Follows the hub's `GET /v1/events` for `work-request-changed` and hands approved ones to the caller. The hub performs the
 * graduation itself on owner approval; wolfd only has to close the feature thread and unbind the other holders live.
 * Reconnects with backoff; an event missed while offline is caught by `closedReasonOf` (the item is graduated/archived).
 */
export interface ApprovedRequest {
  requestId: string;
  itemId: string;
  kind: "graduate" | "archive" | "reassign";
  status: "approved";
  domain?: string;
}

export interface HubEventsTarget {
  /** Hub base URL (no trailing path). */
  url: string;
  token: string;
}

/** The hub behind this wolf: WOLFPACK_HUB_URL/TOKEN, else the Work endpoint (`<hub>/v1/workapi`) with the Work token. */
export function hubEventsTargetFrom(env: NodeJS.ProcessEnv, work?: { endpoint?: string; token?: string }): HubEventsTarget | undefined {
  const url = env.WOLFPACK_HUB_URL?.trim();
  const token = env.WOLFPACK_HUB_TOKEN?.trim();
  if (url && token) return { url, token };
  const ep = (work?.endpoint ?? "").replace(/\/$/, "");
  if (ep.endsWith("/v1/workapi") && work?.token) return { url: ep.slice(0, -"/v1/workapi".length), token: work.token };
  return undefined;
}

/** The `data:` payload of each SSE frame, in stream order. */
async function* dataFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
      const data = frame.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
      if (data) yield data;
    }
  }
}

/** Starts following the hub; returns the stop function. */
export function watchApprovals(
  target: HubEventsTarget,
  onApproved: (r: ApprovedRequest) => void | Promise<void>,
  log: (l: string) => void = () => {},
  opts: { retryMs?: number } = {},
): () => void {
  const ctl = new AbortController();
  const retryMs = opts.retryMs ?? 5_000;
  void (async () => {
    let fails = 0;
    while (!ctl.signal.aborted) {
      try {
        const res = await fetch(`${target.url.replace(/\/$/, "")}/v1/events`, { headers: { Accept: "text/event-stream", Authorization: `Bearer ${target.token}` }, signal: ctl.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        fails = 0;
        for await (const data of dataFrames(res.body)) {
          let ev: Partial<ApprovedRequest> & { type?: string };
          try { ev = JSON.parse(data); } catch { continue; }
          if (ev.type !== "work-request-changed" || ev.status !== "approved" || typeof ev.itemId !== "string") continue;
          try { await onApproved(ev as ApprovedRequest); } catch (e) { log(`approval ${ev.requestId}: ${e instanceof Error ? e.message : String(e)}`); }
        }
      } catch (e) {
        if (ctl.signal.aborted) return;
        if (fails++ === 0) log(`hub events: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}; retrying`);
      }
      await new Promise((r) => {
        const t = setTimeout(r, Math.min(retryMs * 2 ** Math.min(fails, 5), 60_000));
        t.unref();
        ctl.signal.addEventListener("abort", () => { clearTimeout(t); r(undefined); }, { once: true });
      });
    }
  })();
  return () => ctl.abort();
}
