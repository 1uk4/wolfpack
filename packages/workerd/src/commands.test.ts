/** Machine-side command handlers. Fakes only: an injected journalctl runner, a temp log file. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinkCmd, LinkCmdResult } from "@wolfpack/protocol";
import { canRestartSelf, type KeyHandler, createCommandRunner, readWolfStatus, restartWolves, type WolfControl } from "./commands.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "workerd-cmd-"));
  dirs.push(d);
  return d;
};
const logs = (service: string, lines: number): LinkCmd => ({ t: "cmd", id: "c-1", kind: "logs.fetch", args: { service, lines } });

describe("logs.fetch", () => {
  it("on Linux reads the allowlisted unit's journal and returns the lines untouched", async () => {
    // The fake journal only answers for the right unit and line count, so a wrong argv returns nothing.
    const r = createCommandRunner({ platform: "linux", runJournal: async (argv) => (argv.join(" ") === "-u workerd.service -n 2 --no-pager" ? "Nov 12 a  password=hunter2\nNov 12 b\n" : "") });
    const res = await r.handle(logs("workerd", 2));
    expect(res).toEqual({ t: "cmd.result", id: "c-1", ok: true, data: { lines: ["Nov 12 a  password=hunter2", "Nov 12 b"], truncated: false } });
  });

  it("answers unknown_service for a service with no log source, running nothing, on every platform", async () => {
    let ran = false;
    const r = createCommandRunner({ platform: "linux", runJournal: async () => ((ran = true), "") });
    expect(await r.handle(logs("sshd", 5))).toMatchObject({ ok: false, code: "unknown_service", message: "no log for sshd on this machine" });
    expect(ran).toBe(false);
    // The Mac app keeps no workerd log file of its own (its stdout goes to the shared main.log), so there is no source.
    expect(await createCommandRunner({ platform: "darwin" }).handle(logs("workerd", 5))).toMatchObject({ ok: false, code: "unknown_service", message: "no log for workerd on this machine" });
  });

  it("ignores a wolf log source named like a default unit, with a warning, instead of shadowing it", async () => {
    const f = join(tmp(), "w.log");
    writeFileSync(f, "from the wolf file\n");
    const warned: string[] = [];
    const r = createCommandRunner({ platform: "linux", logSources: () => ({ workerd: { file: f } }), runJournal: async () => "from the journal\n", log: (m) => warned.push(m) });
    expect(await r.handle(logs("workerd", 5))).toMatchObject({ ok: true, data: { lines: ["from the journal"] } });
    await r.handle(logs("workerd", 5));
    expect(warned.filter((m) => m.includes("workerd"))).toHaveLength(1); // once, not on every call
  });

  it("on Mac returns the tail of the service's log file", async () => {
    const f = join(tmp(), "wolf.log");
    writeFileSync(f, Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n") + "\n");
    const r = createCommandRunner({ platform: "darwin", logSources: () => ({ hal: { file: f } }) });
    const res = await r.handle(logs("hal", 3));
    expect(res).toMatchObject({ ok: true, data: { lines: ["line 7", "line 8", "line 9"], truncated: false } });
  });

  it("marks a file tail truncated when the file was cut, and starts at a whole line", async () => {
    const f = join(tmp(), "big.log");
    writeFileSync(f, Array.from({ length: 1000 }, (_, i) => `${String(i).padStart(4, "0")} ${"x".repeat(595)}`).join("\n") + "\n"); // 600 KB > the read window
    const r = createCommandRunner({ platform: "darwin", logSources: () => ({ hal: { file: f } }) });
    const data = ((await r.handle(logs("hal", 3))) as { data: { lines: string[]; truncated: boolean } }).data;
    expect(data.lines.map((l) => l.slice(0, 4))).toEqual(["0997", "0998", "0999"]);
    expect(data.truncated).toBe(true);
  });

  it("answers a fixed message, with no path or errno text, when a log file cannot be read", async () => {
    const r = createCommandRunner({ platform: "darwin", logSources: () => ({ hal: { file: "/nonexistent-dir/secret-name.log" } }) });
    const res = await r.handle(logs("hal", 3));
    expect(res).toEqual({ t: "cmd.result", id: "c-1", ok: false, code: "internal", message: "log file not readable" });
  });

  it("retries with fewer lines when journalctl overflows its buffer, so the newest lines come back, marked truncated", async () => {
    const argvs: string[] = [];
    const overflow = Object.assign(new Error("maxBuffer exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: "oldest\nolder" });
    const r = createCommandRunner({
      platform: "linux",
      runJournal: async (argv) => {
        argvs.push(argv[argv.indexOf("-n") + 1]!);
        if (argv[argv.indexOf("-n") + 1] === "5000") throw overflow;
        return "newer\nnewest\n";
      },
    });
    const res = await r.handle(logs("workerd", 5000));
    expect(res).toEqual({ t: "cmd.result", id: "c-1", ok: true, data: { lines: ["newer", "newest"], truncated: true } });
    expect(argvs).toEqual(["5000", "500"]);
  });

  it("when even the retry overflows, uses the partial output without its cut-off last line, marked truncated", async () => {
    // journalctl prints oldest first, so the partial output holds the oldest lines and ends mid-line.
    const stdout = Array.from({ length: 1000 }, (_, i) => `${String(i).padStart(4, "0")} ${"x".repeat(595)}`).join("\n") + "\n1000 cut-of";
    const r = createCommandRunner({ platform: "linux", runJournal: async () => { throw Object.assign(new Error("maxBuffer exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout }); } });
    const res = await r.handle(logs("workerd", 1000));
    expect(res).toMatchObject({ ok: true, data: { truncated: true } });
    const lines = (res as { data: { lines: string[] } }).data.lines;
    expect(lines.at(-1)!.startsWith("0999")).toBe(true);
    expect(Buffer.byteLength(lines.join("\n"))).toBeLessThanOrEqual(256 * 1024);
  });

  it("cuts a single oversized line without splitting a UTF-8 character", async () => {
    const r = createCommandRunner({ platform: "linux", runJournal: async () => "é".repeat(200_000) + "\n" }); // 400 KB, one line
    const data = ((await r.handle(logs("workerd", 5))) as { data: { lines: string[]; truncated: boolean } }).data;
    expect(data.truncated).toBe(true);
    expect(data.lines[0]).not.toContain("\uFFFD");
    expect(Buffer.byteLength(data.lines[0]!)).toBeLessThanOrEqual(256 * 1024);
  });

  it("caps the reply at 256 KB, keeping the newest lines, and sets truncated", async () => {
    const big = Array.from({ length: 1000 }, (_, i) => `${String(i).padStart(4, "0")} ${"x".repeat(595)}`).join("\n"); // ~600 KB
    const r = createCommandRunner({ platform: "linux", runJournal: async () => big });
    const res = await r.handle(logs("workerd", 1000));
    const data = (res as { data: { lines: string[]; truncated: boolean } }).data;
    expect(data.truncated).toBe(true);
    expect(data.lines.at(-1)!.startsWith("0999")).toBe(true);
    expect(data.lines.join("\n").length).toBeLessThanOrEqual(256 * 1024);
    expect(data.lines.length).toBeGreaterThan(300);
  });

  it("answers internal, not a throw, when journalctl fails", async () => {
    const r = createCommandRunner({ platform: "linux", runJournal: async () => { throw new Error("journalctl: not found"); } });
    expect(await r.handle(logs("workerd", 5))).toMatchObject({ ok: false, code: "internal" });
  });

  it("advertises only logs.fetch until handlers are injected, and each kind only with its handler", () => {
    expect(createCommandRunner().supported()).toEqual(["logs.fetch"]);
    expect(createCommandRunner({ wolves: fakeWolves() }).supported()).toEqual(["logs.fetch", "wolves.restart"]);
    expect(createCommandRunner({ restartSelf: { stop: async () => {}, exit: () => {} } }).supported()).toEqual(["logs.fetch", "workerd.restart"]);
    expect(createCommandRunner({ keys: { set: async () => ({ ok: true }), remove: async () => ({ ok: true }) }, hostId: "box" }).supported()).toEqual(["logs.fetch", "key.set", "key.remove"]);
  });
});

/** A fake supervisor: three wolves, hal is mid-reply, bob is stopped, cy fails to restart. */
function fakeWolves(): WolfControl & { restarted: string[] } {
  const restarted: string[] = [];
  const st: Record<string, { wasActive: boolean; midReply: boolean }> = { hal: { wasActive: true, midReply: true }, bob: { wasActive: false, midReply: false }, cy: { wasActive: true, midReply: false } };
  return {
    restarted,
    names: () => Object.keys(st),
    status: async (n) => st[n]!,
    restart: async (n) => {
      if (n === "cy") throw new Error("adopted wolfd has no process handle");
      restarted.push(n);
    },
  };
}

describe("wolves.restart", () => {
  it("reads each wolf's status before restarting and names the wolves, reporting midReply", async () => {
    const w = fakeWolves();
    const res = await restartWolves(w, ["hal", "bob"]);
    expect(res).toEqual({ ok: true, data: { restarted: [{ wolf: "hal", wasActive: true, midReply: true }, { wolf: "bob", wasActive: false, midReply: false }] } });
    expect(w.restarted).toEqual(["hal", "bob"]);
  });

  it("with no wolf named restarts all of them; the status read alone restarts nothing", async () => {
    const w = fakeWolves();
    expect(await readWolfStatus(w)).toEqual([{ wolf: "hal", wasActive: true, midReply: true }, { wolf: "bob", wasActive: false, midReply: false }, { wolf: "cy", wasActive: true, midReply: false }]);
    expect(w.restarted).toEqual([]);
    const res = await restartWolves(w);
    expect(w.restarted).toEqual(["hal", "bob"]);
    expect(res).toMatchObject({ ok: false, code: "restart_failed" });
  });

  it("an unconfirmed restart is reported as ok with the message 'restarted, but could not confirm'", async () => {
    const w: WolfControl = { names: () => ["hal"], status: async () => ({ wasActive: true, midReply: false }), restart: async () => ({ unconfirmed: true }) };
    const res = await createCommandRunner({ wolves: w }).handle({ t: "cmd", id: "c-8", kind: "wolves.restart", args: {} });
    expect(res).toEqual({ t: "cmd.result", id: "c-8", ok: true, message: "restarted, but could not confirm", data: { restarted: [{ wolf: "hal", wasActive: true, midReply: false }] } });
  });

  it("an unknown wolf name restarts nothing and says not_found", async () => {
    const w = fakeWolves();
    expect(await restartWolves(w, ["nope"])).toMatchObject({ ok: false, code: "not_found" });
    expect(w.restarted).toEqual([]);
  });

  it("starts every restart before any finishes, so many wolves fit the hub's timeout", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w: WolfControl = { names: () => ["a", "b", "c"], status: async () => ({ wasActive: true, midReply: false }), restart: async (n) => (started.push(n), gate) };
    const done = restartWolves(w);
    await vi.waitFor(() => expect(started).toEqual(["a", "b", "c"]));
    release();
    expect(await done).toMatchObject({ ok: true, data: { restarted: [{ wolf: "a" }, { wolf: "b" }, { wolf: "c" }] } });
  });

  it("the runner dispatches wolves.restart to the injected control", async () => {
    const r = createCommandRunner({ wolves: fakeWolves() });
    const res = await r.handle({ t: "cmd", id: "c-9", kind: "wolves.restart", args: { wolf: "bob" } });
    expect(res).toEqual({ t: "cmd.result", id: "c-9", ok: true, data: { restarted: [{ wolf: "bob", wasActive: false, midReply: false }] } });
  });
});

describe("workerd.restart", () => {
  const cmd: LinkCmd = { t: "cmd", id: "c-5", kind: "workerd.restart", args: {} };
  it("acks first, then stops workerd cleanly, and exits 75 only after the stop finished", async () => {
    const order: string[] = [];
    const r = createCommandRunner({ restartSelf: { stop: async () => void order.push("stop"), exit: (code) => order.push(`exit ${code}`) } });
    const res = await r.handle(cmd);
    order.push("ack " + (res.ok ? "ok" : "fail"));
    r.afterSend(cmd, res);
    await vi.waitFor(() => expect(order).toContain("exit 75"));
    expect(order).toEqual(["ack ok", "stop", "exit 75"]);
  });

  it("exits 75 anyway when the stop hangs past the fallback time", async () => {
    vi.useFakeTimers();
    try {
      const exits: number[] = [];
      const r = createCommandRunner({ restartSelf: { stop: () => new Promise<void>(() => {}), exit: (c) => exits.push(c), fallbackMs: 10_000 } });
      r.afterSend(cmd, { t: "cmd.result", id: "c-5", ok: true });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(exits).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(exits).toEqual([75]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("two workerd.restart commands stop and exit once", async () => {
    const events: string[] = [];
    const r = createCommandRunner({ restartSelf: { stop: async () => void events.push("stop"), exit: (c) => events.push(`exit ${c}`) } });
    const ack: LinkCmdResult = { t: "cmd.result", id: "c-5", ok: true };
    r.afterSend(cmd, ack);
    r.afterSend({ ...cmd, id: "c-6" }, { ...ack, id: "c-6" });
    await vi.waitFor(() => expect(events).toContain("exit 75"));
    await new Promise((res) => setTimeout(res, 20));
    expect(events).toEqual(["stop", "exit 75"]);
  });

  it("does not exit after a different command or a failed ack", async () => {
    const exits: number[] = [];
    const r = createCommandRunner({ restartSelf: { stop: async () => {}, exit: (c) => exits.push(c) } });
    r.afterSend({ ...cmd, kind: "logs.fetch", args: { service: "workerd", lines: 1 } }, { t: "cmd.result", id: "c-5", ok: true });
    r.afterSend(cmd, { t: "cmd.result", id: "c-5", ok: false, code: "internal" });
    expect(exits).toEqual([]);
  });

  it("is judged restartable only under a real systemd service: the Mac app, a bare terminal run, a stray INVOCATION_ID and non-Linux are not", () => {
    expect(canRestartSelf({ INVOCATION_ID: "abc", JOURNAL_STREAM: "8:1" }, "linux", 4242)).toBe(true);
    expect(canRestartSelf({ INVOCATION_ID: "abc", NOTIFY_SOCKET: "/run/systemd/notify" }, "linux", 4242)).toBe(true);
    expect(canRestartSelf({ INVOCATION_ID: "abc" }, "linux", 1)).toBe(true);
    expect(canRestartSelf({ INVOCATION_ID: "abc" }, "linux", 4242)).toBe(false); // an exported id in a shell, not a service
    expect(canRestartSelf({ JOURNAL_STREAM: "8:1" }, "linux", 1)).toBe(false);
    expect(canRestartSelf({}, "linux", 4242)).toBe(false);
    expect(canRestartSelf({ INVOCATION_ID: "abc", JOURNAL_STREAM: "8:1", WOLFPACK_EXIT_WITH_PARENT: "1" }, "linux", 1)).toBe(false);
    expect(canRestartSelf({ WOLFPACK_EXIT_WITH_PARENT: "1", WOLFPACK_SINGLE_MAC: "1", ELECTRON_RUN_AS_NODE: "1" }, "darwin", 1)).toBe(false);
  });
});

describe("key.set / key.remove", () => {
  function fakeKeys(result: { ok: true } | { ok: false; code: "rejected_key" | "bad_seal" | "replay" | "store_failed"; message?: string } = { ok: true }) {
    const calls: unknown[] = [];
    const h: KeyHandler = { set: async (a) => (calls.push(["set", a]), result), remove: async (a) => (calls.push(["remove", a]), result) };
    return { h, calls };
  }
  it("are not run until a KeyHandler is injected", async () => {
    const r = createCommandRunner();
    expect(await r.handle({ t: "cmd", id: "c-7", kind: "key.set", args: { slot: "anthropic" }, sealed: "S" })).toMatchObject({ ok: false, code: "internal" });
  });

  it("forward slot, sealed bytes, hostId and the command id to the handler and return ok", async () => {
    const { h, calls } = fakeKeys();
    const r = createCommandRunner({ keys: h, hostId: "box" });
    expect(await r.handle({ t: "cmd", id: "c-7", kind: "key.set", args: { slot: "anthropic" }, sealed: "SEALED" })).toEqual({ t: "cmd.result", id: "c-7", ok: true });
    expect(await r.handle({ t: "cmd", id: "c-8", kind: "key.remove", args: { slot: "anthropic" } })).toEqual({ t: "cmd.result", id: "c-8", ok: true });
    expect(calls).toEqual([["set", { slot: "anthropic", sealed: "SEALED", hostId: "box", cmdId: "c-7" }], ["remove", { slot: "anthropic" }]]);
  });

  it("pass the handler's refusal code through, and a key.set with no sealed bytes is bad_seal without calling it", async () => {
    const { h, calls } = fakeKeys({ ok: false, code: "replay", message: "seen before" });
    const r = createCommandRunner({ keys: h, hostId: "box" });
    expect(await r.handle({ t: "cmd", id: "c-9", kind: "key.set", args: { slot: "a" }, sealed: "S" })).toEqual({ t: "cmd.result", id: "c-9", ok: false, code: "replay", message: "seen before" });
    calls.length = 0;
    expect(await r.handle({ t: "cmd", id: "c-10", kind: "key.set", args: { slot: "a" } })).toMatchObject({ ok: false, code: "bad_seal" });
    expect(calls).toEqual([]);
  });

  it("a throwing handler answers store_failed without echoing the error text", async () => {
    const r = createCommandRunner({ keys: { set: async () => { throw new Error("disk said SEALEDSECRET"); }, remove: async () => ({ ok: true }) }, hostId: "box" });
    const res = await r.handle({ t: "cmd", id: "c-11", kind: "key.set", args: { slot: "a" }, sealed: "S" });
    expect(res).toMatchObject({ ok: false, code: "store_failed" });
    expect(JSON.stringify(res)).not.toContain("SEALEDSECRET");
  });
});
