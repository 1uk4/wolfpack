/** The `pin` tool's object lookup against a real pi-durable store: forks, other threads, failed calls, same-message order. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createObjectsExtension } from "./objects.js";
import { openWolfEngine, type WolfEngine } from "./index.js";

let dir: string;
let engine: WolfEngine;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "wolf-objects-"));
  engine = await openWolfEngine(join(dir, "session.sqlite"), { cwd: dir });
});
afterEach(async () => {
  await engine.close();
  rmSync(dir, { recursive: true, force: true });
});

const model = { provider: "anthropic", modelId: "claude-haiku-5-5" };
const show = (id: string, objectId: string) => ({ type: "toolCall", id, name: "show_checklist", arguments: { objectId, items: [{ id: "a", label: "A", state: "todo" }] } });
const pinCall = (id: string, objectId: string) => ({ type: "toolCall", id, name: "pin", arguments: { objectId, pinned: true } });

async function append(conversationId: number, message: object): Promise<number> {
  const rec = await engine.harness.commit((tx) => tx.appendEntry(conversationId as never, { kind: "message", model: [message] as never }), ctx);
  return Number(rec.id);
}

type PinResult = { isError?: boolean; output: Array<{ text: string }> };

/** Run the `pin` tool as the model would, from `conversationId`, for the call `callId`. The reader is registered under the store's directory. */
async function runPin(conversationId: number, objectId: string, callId = "pin-call", den = dir): Promise<PinResult> {
  const tool = createObjectsExtension(den).tools!.find((t) => t.name === "pin")!;
  return (await tool.execute({ objectId, pinned: true } as never, { conversationId, callId } as never, {} as never)) as PinResult;
}

describe("pin tool object lookup", () => {
  it("finds an object shown in history a fork inherited", async () => {
    const root = await engine.conversations.root({ model });
    const at = await append(Number(root.id), { role: "assistant", content: [show("s1", "A")] });
    const fork = await (await engine.harness.conversation(Number(root.id) as never, ctx))!.fork(at as never, { ownership: { kind: "ownerless" } }, ctx);
    expect((await runPin(Number(fork.id), "A")).isError).toBeFalsy();
  });

  it("errors for an object shown only in a different thread", async () => {
    const root = await engine.conversations.root({ model });
    await append(Number(root.id), { role: "assistant", content: [show("s1", "A")] });
    const other = await engine.conversations.create({ model });
    const r = await runPin(Number(other.id), "A");
    expect(r.isError).toBe(true);
    expect(r.output[0]!.text).toContain('No object "A"');
  });

  it("errors when the show call failed", async () => {
    const root = await engine.conversations.root({ model });
    await append(Number(root.id), { role: "assistant", content: [show("s1", "A")] });
    await append(Number(root.id), { role: "toolResult", toolCallId: "s1", toolName: "show_checklist", isError: true, content: [{ type: "text", text: "bad" }] });
    const r = await runPin(Number(root.id), "A");
    expect(r.isError).toBe(true);
    expect(r.output[0]!.text).toContain('No object "A"');
  });

  it("accepts a show call earlier in the same assistant message, not one after the pin", async () => {
    const root = await engine.conversations.root({ model });
    await append(Number(root.id), { role: "assistant", content: [show("s1", "A"), pinCall("p1", "A"), pinCall("p2", "B"), show("s2", "B")] });
    expect((await runPin(Number(root.id), "A", "p1")).isError).toBeFalsy();
    expect((await runPin(Number(root.id), "B", "p2")).isError).toBe(true);
  });

  it("allows the pin and warns once when no reader is registered", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const den = join(dir, "no-such-den");
    expect((await runPin(1, "A", "c", den)).isError).toBeFalsy();
    await runPin(1, "A", "c", den);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
