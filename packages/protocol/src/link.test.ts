import { describe, expect, it } from "vitest";
import { LINK_RELAY_CHUNK_BYTES, LINK_RELAY_HARD_SLACK, LINK_RELAY_PAUSE_HIGH, encodeLinkFrame, parseLinkFrame, LinkWolfSchema } from "./link.js";

describe("relay flow-control frames", () => {
  it("pause and resume round-trip and need a non-empty id", () => {
    for (const t of ["pause", "resume"] as const) {
      const p = parseLinkFrame(encodeLinkFrame({ t, id: "h-7" }));
      expect(p).toEqual({ ok: true, frame: { t, id: "h-7" } });
      expect(parseLinkFrame(JSON.stringify({ t, id: "" })).ok).toBe(false);
      expect(parseLinkFrame(JSON.stringify({ t })).ok).toBe(false);
    }
  });
  it("thresholds are ordered and a chunk always fits under the pause point plus slack", () => {
    expect(LINK_RELAY_CHUNK_BYTES).toBeLessThanOrEqual(LINK_RELAY_PAUSE_HIGH);
    expect(LINK_RELAY_HARD_SLACK).toBeGreaterThan(LINK_RELAY_CHUNK_BYTES);
  });
});

describe("hello wolves: additive KB flags", () => {
  it("old shape parses with no flags; new shape keeps them; non-boolean is refused", () => {
    expect(LinkWolfSchema.parse({ name: "a" })).toEqual({ name: "a", domains: [] });
    expect(LinkWolfSchema.parse({ name: "a", librarian: true, kbReadable: false })).toMatchObject({ librarian: true, kbReadable: false });
    expect(LinkWolfSchema.safeParse({ name: "a", librarian: "yes" }).success).toBe(false);
    const hello = { t: "hello", v: 1, hostId: "box", laptop: false, wolves: [{ name: "a", domains: [], kbReadable: true }], kbRevisions: {} };
    expect(parseLinkFrame(JSON.stringify(hello)).ok).toBe(true);
  });

  it("hello carries an optional machine name", () => {
    const hello = { t: "hello", v: 1, hostId: "sfo-01-wolves", laptop: false, wolves: [], kbRevisions: {} };
    const withMachine = parseLinkFrame(JSON.stringify({ ...hello, machine: "sfo-01" }));
    expect(withMachine.ok && withMachine.frame).toMatchObject({ machine: "sfo-01" });
    const without = parseLinkFrame(JSON.stringify(hello));
    expect(without.ok && (without.frame as { machine?: string }).machine).toBeUndefined();
  });
});

describe("command frames", () => {
  it("cmd and cmd.result round-trip; unknown kinds, bad ids and bad line counts are refused", () => {
    const cmd = { t: "cmd", id: "c-1b2e", kind: "logs.fetch", args: { service: "workerd", lines: 200 } };
    expect(parseLinkFrame(JSON.stringify(cmd))).toEqual({ ok: true, frame: cmd });
    const restart = { t: "cmd", id: "c-2", kind: "wolves.restart", args: { wolf: "hal" } };
    expect(parseLinkFrame(JSON.stringify(restart)).ok).toBe(true);
    const key = { t: "cmd", id: "c-3", kind: "key.set", args: { slot: "anthropic" }, sealed: "AAAA" };
    expect(parseLinkFrame(JSON.stringify(key))).toEqual({ ok: true, frame: key });
    expect(parseLinkFrame(JSON.stringify({ ...cmd, kind: "rm.rf" })).ok).toBe(false);
    expect(parseLinkFrame(JSON.stringify({ ...cmd, id: "x-1" })).ok).toBe(false);
    expect(parseLinkFrame(JSON.stringify({ ...cmd, args: { service: "workerd", lines: 5000 } })).ok).toBe(false);
    const res = { t: "cmd.result", id: "c-2", ok: true, data: { restarted: [{ wolf: "hal", wasActive: true, midReply: false }] } };
    expect(parseLinkFrame(JSON.stringify(res))).toEqual({ ok: true, frame: res });
    const fail = { t: "cmd.result", id: "c-2", ok: false, code: "restart_failed", message: "boom" };
    expect(parseLinkFrame(JSON.stringify(fail))).toEqual({ ok: true, frame: fail });
    expect(parseLinkFrame(JSON.stringify({ ...fail, code: "made_up" })).ok).toBe(false);
  });

  it("refuses extra or wrong-kind args, and accepts workerd.restart with empty args", () => {
    const f = (kind: string, args: unknown) => parseLinkFrame(JSON.stringify({ t: "cmd", id: "c-9", kind, args })).ok;
    expect(f("workerd.restart", {})).toBe(true);
    expect(f("workerd.restart", { slot: "x" })).toBe(false);
    expect(f("key.remove", { slot: "a", extra: 1 })).toBe(false);
    expect(f("logs.fetch", { service: "workerd", lines: 5, wolf: "hal" })).toBe(false);
    expect(f("wolves.restart", { service: "workerd", lines: 5 })).toBe(false);
    expect(f("wolves.restart", {})).toBe(true);
  });

  it("accepts the unknown_service and not_found result codes", () => {
    for (const code of ["unknown_service", "not_found"]) expect(parseLinkFrame(JSON.stringify({ t: "cmd.result", id: "c-2", ok: false, code })).ok).toBe(true);
  });

  it("hello advertises commands and pubkey optionally; an old hello has neither", () => {
    const hello = { t: "hello", v: 1, hostId: "box", laptop: false, wolves: [], kbRevisions: {} };
    const old = parseLinkFrame(JSON.stringify(hello));
    expect(old.ok && (old.frame as { commands?: string[] }).commands).toBeUndefined();
    const nu = parseLinkFrame(JSON.stringify({ ...hello, commands: ["logs.fetch", "wolves.restart"], pubkey: "abc" }));
    expect(nu.ok && nu.frame).toMatchObject({ commands: ["logs.fetch", "wolves.restart"], pubkey: "abc" });
    expect(parseLinkFrame(JSON.stringify({ ...hello, commands: ["nope"] })).ok).toBe(false);
  });
});
