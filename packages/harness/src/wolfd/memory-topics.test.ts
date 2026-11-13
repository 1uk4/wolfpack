/** The Memory panel's Topics section over /v1: the list with size, sources, state and keep-local, and the keep-local toggle. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryTopicsSchema, PROTOCOL_VERSION } from "@wolfpack/protocol";
import { readTopics, updateTopicState, writeTopic } from "@wolfpack/memory";
import { registerMemoryActions, unregisterMemoryActions, type MemoryActions } from "../memory/actions.js";
import { ScriptedEngine } from "./scripted-engine.js";
import { WolfServer } from "./server.js";

const dens: string[] = [];
const servers: WolfServer[] = [];
const registered: Array<[string, MemoryActions]> = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const [d, a] of registered.splice(0)) unregisterMemoryActions(d, a);
  for (const d of dens.splice(0)) rmSync(d, { recursive: true, force: true });
});

const H = { "X-Protocol-Version": String(PROTOCOL_VERSION) };

async function boot() {
  const den = mkdtempSync(join(tmpdir(), "wolfd-topics-"));
  dens.push(den);
  const actions = { promoteEnabled: false, isBusy: () => false, consolidate: async () => ({}) as never, promote: () => ({}) as never } as MemoryActions;
  registerMemoryActions(den, actions); // memory counts as running
  registered.push([den, actions]);
  const root = join(den, ".memory", "sessions", "durable");
  mkdirSync(root, { recursive: true });
  const s = new WolfServer({ name: "w", den, conversation: new ScriptedEngine({ delayMs: 1, id: "900" }), conversations: { create: async () => new ScriptedEngine({ delayMs: 1, id: "101" }), get: async () => undefined } as never });
  servers.push(s);
  await s.attach();
  return { den, root, url: await s.listen() };
}

describe("memory session topics route", () => {
  it("lists each topic with bytes, sources, state and keep-local, and the retired ones apart", async () => {
    const { den, root, url } = await boot();
    const base = { summary: "s", updated: "2026-11-13 09:00", body: "body" };
    writeTopic(root, { ...base, id: "active-one", title: "Active", sources: ["thread:1"] });
    writeTopic(root, { ...base, id: "sent", title: "Sent", sources: ["work-wolfpack-F1"] });
    writeTopic(root, { ...base, id: "stuck", title: "Stuck", state: "parked", keepLocal: true });
    updateTopicState(den, "sent", { promotedAt: "2026-11-13T09:00:00.000Z", receipt: { outcome: "create", entryIds: ["kb-a"] } });
    updateTopicState(den, "gone", { promotedAt: "2026-11-12T09:00:00.000Z", retiredAt: "2026-11-13T00:00:00.000Z", receipt: { outcome: "merge", entryIds: ["kb-b"] } });
    writeTopic(join(root, "retired"), { ...base, id: "gone", title: "Gone", sources: ["thread:2"] });

    const res = await fetch(`${url}/v1/wolves/w/memory/session-topics`, { headers: H });
    expect(res.status).toBe(200);
    const body = MemoryTopicsSchema.parse(await res.json());
    const byId = Object.fromEntries(body.topics.map((t) => [t.id, t]));
    expect(byId["active-one"]).toMatchObject({ state: "active", sources: ["thread:1"], keepLocal: false, entryIds: [] });
    expect(byId.sent).toMatchObject({ state: "promoted", sources: ["work-wolfpack-F1"], entryIds: ["kb-a"] });
    expect(byId.stuck).toMatchObject({ state: "parked", keepLocal: true });
    expect(byId["active-one"].bytes).toBeGreaterThan(0);
    expect(body.totalBytes).toBe(body.topics.reduce((n, t) => n + t.bytes, 0));
    expect(body.capBytes).toBe(184320);
    expect(body.retired.map((t) => [t.id, t.state, t.entryIds])).toEqual([["gone", "retired", ["kb-b"]]]);
  });

  it("sets and clears keep-local on a topic; an unknown topic is 404", async () => {
    const { root, url } = await boot();
    writeTopic(root, { id: "t", title: "T", summary: "s", updated: "2026-11-13 09:00", body: "b", sources: ["thread:1"] });
    const put = (id: string, keepLocal: boolean) => fetch(`${url}/v1/wolves/w/memory/topics/${id}/keep-local`, { method: "PUT", headers: H, body: JSON.stringify({ keepLocal }) });
    const on = await put("t", true);
    expect(on.status, JSON.stringify(await on.clone().json())).toBe(200);
    expect(await on.json()).toEqual({ id: "t", keepLocal: true });
    expect(readTopics(root)[0]).toMatchObject({ keepLocal: true, sources: ["thread:1"] });
    expect(await (await put("t", false)).json()).toEqual({ id: "t", keepLocal: false });
    expect(readTopics(root)[0].keepLocal).toBeUndefined();
    expect((await put("nope", true)).status).toBe(404);
  });
});
