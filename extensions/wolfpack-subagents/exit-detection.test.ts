import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findDoneMarker, pollForExitWith, probeExitWith, type MuxBackend } from "./mux/shared.ts";

function fakeBackend(screen: () => string | Error) {
  const sendCommand = vi.fn();
  const readScreenAsync = vi.fn(async (_s: string, _lines?: number) => {
    const v = screen();
    if (v instanceof Error) throw v;
    return v;
  });
  const backend = {
    name: "fake",
    isAvailable: () => true,
    setupHint: () => "",
    createSurface: () => "fake:1",
    sendCommand,
    readScreen: () => "",
    readScreenAsync,
    closeSurface: () => {},
  } as unknown as MuxBackend;
  return { backend, sendCommand, readScreenAsync };
}

// Footer, resume hint, marker, zsh timing line and a multi-line prompt: the
// marker sits well above the last 5 rows.
const exitedScreen = [
  "~/Code/wolfpack (main)",
  "To resume this session: pi --session abc",
  "__SUBAGENT_DONE_0__",
  "bash  58.88s user 13.89s system 108% cpu 1:07.32 total",
  "",
  "",
  "~/Code/wolfpack  v22.23.3",
  "(base) ▷ ",
  "",
].join("\n");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "exit-detect-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("findDoneMarker", () => {
  it("finds the marker and exit code, newest wins", () => {
    expect(findDoneMarker(exitedScreen)).toBe(0);
    expect(findDoneMarker("__SUBAGENT_DONE_1__\nfoo\n__SUBAGENT_DONE_130__")).toBe(130);
    expect(findDoneMarker("echo '__SUBAGENT_DONE_'$?'__'")).toBeNull();
    expect(findDoneMarker("nothing here")).toBeNull();
  });
});

describe("pollForExitWith", () => {
  it("detects a marker followed by timing line and prompt", async () => {
    const { backend, readScreenAsync } = fakeBackend(() => exitedScreen);
    const result = await pollForExitWith(backend, "fake:1", new AbortController().signal, { interval: 5 });
    expect(result).toEqual({ reason: "sentinel", exitCode: 0 });
    // The scan window must be wide enough to see past the prompt.
    expect(readScreenAsync.mock.calls[0][1]).toBeGreaterThan(20);
  });

  it("keeps polling until the marker appears", async () => {
    let n = 0;
    const { backend } = fakeBackend(() => (++n < 3 ? "pi footer\n" : exitedScreen));
    const result = await pollForExitWith(backend, "fake:1", new AbortController().signal, { interval: 5 });
    expect(result.exitCode).toBe(0);
    expect(n).toBe(3);
  });
});

describe("probeExitWith", () => {
  it("returns null while the agent is alive", async () => {
    const { backend } = fakeBackend(() => "pi is working...\n");
    expect(await probeExitWith(backend, "fake:1", {})).toBeNull();
  });

  it("detects exit from the pane marker without consuming files", async () => {
    const { backend } = fakeBackend(() => exitedScreen);
    expect(await probeExitWith(backend, "fake:1", {})).toEqual({ reason: "sentinel", exitCode: 0 });
  });

  it("detects exit from the error sidecar and leaves it for the poller", async () => {
    const sessionFile = join(dir, "s.jsonl");
    writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "error", errorMessage: "boom" }));
    const { backend } = fakeBackend(() => "alive\n");
    const r = await probeExitWith(backend, "fake:1", { sessionFile });
    expect(r).toMatchObject({ reason: "error", errorMessage: "boom" });
    const again = await probeExitWith(backend, "fake:1", { sessionFile });
    expect(again?.reason).toBe("error");
  });

  it("throws when the pane is unreadable and there is no file evidence", async () => {
    const { backend } = fakeBackend(() => new Error("pane gone"));
    await expect(probeExitWith(backend, "fake:1", {})).rejects.toThrow("pane gone");
  });
});
