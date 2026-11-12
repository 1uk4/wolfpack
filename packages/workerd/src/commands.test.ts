/** Machine-side command handlers. Fakes only: an injected journalctl runner, a temp log file. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LinkCmd } from "@wolfpack/protocol";
import { createCommandRunner } from "./commands.js";

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

  it("advertises only logs.fetch until further handlers are injected", () => {
    expect(createCommandRunner().supported()).toEqual(["logs.fetch"]);
  });
});
