import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchApprovals, type ApprovedRequest } from "./hub-approvals.js";

let server: Server | undefined;
let stop: (() => void) | undefined;
afterEach(async () => {
  stop?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
});

/** A hub whose event stream sends these data frames, then stays open. */
async function hubSending(frames: unknown[]) {
  server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "tok" };
}

describe("watchApprovals", () => {
  it("hands over an approved graduate request and a direct work-graduated event alike, and ignores pending and non-graduate ones", async () => {
    const target = await hubSending([
      { type: "work-request-changed", requestId: "req-1", itemId: "work-wp-aaa", kind: "graduate", status: "pending" },
      { type: "work-request-changed", requestId: "req-2", itemId: "work-wp-bbb", kind: "graduate", status: "approved", domain: "wp" },
      { type: "work-graduated", itemId: "work-wp-ccc", domain: "wp", via: "card" },
    ]);
    const seen: ApprovedRequest[] = [];
    stop = watchApprovals(target, (r) => void seen.push(r));
    await vi.waitFor(() => expect(seen.length).toBe(2), { timeout: 3000 });
    expect(seen.map((r) => [r.itemId, r.kind, r.status, r.domain])).toEqual([
      ["work-wp-bbb", "graduate", "approved", "wp"],
      ["work-wp-ccc", "graduate", "approved", "wp"],
    ]);
  });
});
