/** runWorkerd owns the ONE work server per shared sandbox root, before any wolf starts. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sandboxPaths, takeSnapshot } from "@wolfpack/engine";
import { runWorkerd, type RunningWorkerd } from "./run.js";
import { FAKE_COMMAND } from "./testing/helpers.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workerd-run-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const src = join(root, "src");
  mkdirSync(join(src, "work/ledger"), { recursive: true });
  writeFileSync(join(src, "work/ledger/work-events.jsonl"), "");
  mkdirSync(join(src, "den"), { recursive: true });
  const sandbox = join(root, "sandbox");
  takeSnapshot({ source: { workDir: join(src, "work"), denDir: join(src, "den") }, devRoot: sandbox, denName: "a" });
  const wolves = join(root, "wolves");
  for (const n of ["a", "b"]) {
    mkdirSync(join(wolves, n), { recursive: true });
    writeFileSync(join(wolves, n, "wolf.yaml"), `name: ${n}\nserve:\n  socket: ${join(root, `${n}.sock`)}\nsandbox:\n  root: ${sandbox}\n`);
  }
  return { sandbox, wolves };
}

describe("runWorkerd shared sandbox", () => {
  it("starts exactly one work server for two wolves on one root, publishes it, and a second workerd cannot start another", async () => {
    const f = fixture();
    const started: string[] = [];
    const lines: string[] = [];
    const startWorkServer = async () => {
      started.push("x");
      return { url: "http://127.0.0.1:45001", close: async () => {} };
    };
    const w: RunningWorkerd = await runWorkerd({ wolvesDir: f.wolves, port: 0, command: FAKE_COMMAND, startWorkServer, log: (l) => lines.push(l) });
    cleanup.push(() => w.close());
    expect(started).toHaveLength(1);
    expect(JSON.parse(readFileSync(sandboxPaths(f.sandbox).workServerFile, "utf8")).url).toBe("http://127.0.0.1:45001");
    expect(lines.some((l) => l.includes("the only ledger writer"))).toBe(true);

    const lines2: string[] = [];
    const w2 = await runWorkerd({ wolvesDir: f.wolves, port: 0, command: FAKE_COMMAND, startWorkServer, only: ["a"], log: (l) => lines2.push(l) });
    cleanup.push(() => w2.close());
    expect(started).toHaveLength(1); // no second writer
    expect(lines2.some((l) => /no shared work server: .*already has a writer/.test(l))).toBe(true);

    await w.close();
    expect(existsSync(sandboxPaths(f.sandbox).workServerLock)).toBe(false);
  });
});
