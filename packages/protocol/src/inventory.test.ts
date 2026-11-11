import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INVENTORY_MAX_ENTRIES, InventoryEntrySchema } from "./inventory.js";
import { parseLinkFrame } from "./link.js";
import { readMachineChannel } from "./health-lag.js";

const entry = { machine: "sfo-01", kind: "workerd", id: "sfo-01-wolves", version: "0.1.5", channel: "main" };

describe("inventory link frames", () => {
  it("a report frame carries entries; a bad kind, an extra-long list or a missing list is rejected", () => {
    const ok = parseLinkFrame(JSON.stringify({ t: "report", entries: [entry] }));
    expect(ok.ok && ok.frame).toMatchObject({ t: "report", entries: [{ id: "sfo-01-wolves", channel: "main" }] });
    expect(parseLinkFrame(JSON.stringify({ t: "report", entries: [{ ...entry, kind: "toaster" }] })).ok).toBe(false);
    const many = Array.from({ length: INVENTORY_MAX_ENTRIES + 1 }, () => entry);
    expect(parseLinkFrame(JSON.stringify({ t: "report", entries: many })).ok).toBe(false);
    expect(parseLinkFrame(JSON.stringify({ t: "report" })).ok).toBe(false);
  });

  it("an old welcome (no inventory flag) still parses; the flag is optional and boolean", () => {
    const w = { t: "welcome", v: 1, heartbeatMs: 1000, deadAfterMs: 3000 };
    const old = parseLinkFrame(JSON.stringify(w));
    expect(old.ok && (old.frame as { inventory?: boolean }).inventory).toBeUndefined();
    const flagged = parseLinkFrame(JSON.stringify({ ...w, inventory: true }));
    expect(flagged.ok && (flagged.frame as { inventory?: boolean }).inventory).toBe(true);
  });

  it("an entry rejects negative uptime and an unknown channel", () => {
    expect(InventoryEntrySchema.safeParse({ ...entry, uptimeS: -1 }).success).toBe(false);
    expect(InventoryEntrySchema.safeParse({ ...entry, channel: "beta" }).success).toBe(false);
  });
});

describe("readMachineChannel", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "chan-"));
  const file = (name: string, text: string) => {
    const f = path.join(dir, name);
    writeFileSync(f, text);
    return f;
  };
  it("reads the channel; a missing file is stable; an unreadable one is undefined", () => {
    expect(readMachineChannel({ WOLFPACK_SUBSCRIPTION_FILE: file("a.json", '{"channel":"main","mode":"auto"}') })).toBe("main");
    expect(readMachineChannel({ WOLFPACK_SUBSCRIPTION_FILE: path.join(dir, "missing.json") })).toBe("stable");
    expect(readMachineChannel({ WOLFPACK_SUBSCRIPTION_FILE: file("b.json", "{nope") })).toBeUndefined();
    expect(readMachineChannel({ WOLFPACK_SUBSCRIPTION_FILE: dir })).toBeUndefined();
  });
});
