import { afterAll, beforeAll, expect, it } from "vitest";
import { runContractSuite } from "../contract/index.js";
import { StubServer } from "./index.js";

const stub = new StubServer({ delayMs: 15 });
let url = "";
beforeAll(async () => {
  url = await stub.listen();
});
afterAll(() => stub.close());

runContractSuite(() => url, { closeFeatureThread: (id) => stub.closeThread(`${stubWolf()}/feature-${id}`) });
const stubWolf = () => "1uk4";

it("stub: memory actions answer the exact memory_unavailable envelope", async () => {
  const wolf = ((await (await fetch(`${url}/v1/wolves`)).json()) as { wolves: { name: string }[] }).wolves[0].name;
  for (const action of ["consolidate", "promote"]) {
    const res = await fetch(`${url}/v1/wolves/${wolf}/memory/${action}`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "memory_unavailable", message: "memory is not loaded on this wolf", retryable: false });
  }
});

it("stub: a fixture subagent is listed under its parent, has a ledger and takes submits like any thread", async () => {
  const { DEFAULT_FIXTURE } = await import("./index.js");
  const { ROUTES, buildPath } = await import("../index.js");
  const child = "1uk4/sub-1";
  const kids = new StubServer({
    delayMs: 5,
    fixture: {
      ...DEFAULT_FIXTURE,
      threads: [
        ...DEFAULT_FIXTURE.threads,
        { id: child, wolf: "1uk4", kind: "subagent", title: "scout", parentThreadId: "1uk4/home", agent: "scout", state: "done", startedAt: "2026-10-27T10:00:00.000Z", finishedAt: "2026-10-27T10:01:00.000Z", tokens: 1200 },
      ],
      ledgers: { [child]: [{ id: 1, at: "2026-10-27T10:00:00.000Z", from: "parent", to: "child", kind: "brief", text: "look around" }] },
    },
  });
  const base = await kids.listen();
  try {
    const list = ROUTES.listChildren.response.schema.parse(await (await fetch(base + buildPath("listChildren", { id: "1uk4/home" }))).json()) as { threads: { id: string; parentThreadId?: string }[] };
    expect(list.threads.map((t) => t.id)).toEqual([child]);
    expect(list.threads[0].parentThreadId).toBe("1uk4/home");
    const ledger = ROUTES.getLedger.response.schema.parse(await (await fetch(base + buildPath("getLedger", { id: child }))).json()) as { entries: { kind: string }[] };
    expect(ledger.entries.map((e) => e.kind)).toEqual(["brief"]);
    const ack = await fetch(base + buildPath("submit", { id: child }), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: "more", whenBusy: "reject" }) });
    expect(ack.status).toBe(200);
  } finally {
    await kids.close();
  }
});
