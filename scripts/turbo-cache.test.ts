import { describe, it, expect } from "vitest";
import os from "node:os";
// @ts-expect-error plain .mjs without types
import { turboCacheDir, runTurbo } from "./turbo.mjs";

describe("turboCacheDir: one local build cache shared by every worktree on this machine", () => {
	it("defaults to ~/.cache/wolfpack/turbo under the real home", () => {
		expect(turboCacheDir({}, "/Users/me")).toBe("/Users/me/.cache/wolfpack/turbo");
	});
	it("honours XDG_CACHE_HOME", () => {
		expect(turboCacheDir({ XDG_CACHE_HOME: "/x" }, "/Users/me")).toBe("/x/wolfpack/turbo");
	});
	it("respects an explicit TURBO_CACHE_DIR", () => {
		expect(turboCacheDir({ TURBO_CACHE_DIR: "/tmp/c" }, "/Users/me")).toBe("/tmp/c");
	});
	it("returns undefined in CI, which restores no turbo cache", () => {
		expect(turboCacheDir({ CI: "true" }, "/Users/me")).toBeUndefined();
	});
});

type Call = { cmd: string; args: string[]; opts: { env: Record<string, string>; shell?: boolean; stdio: string } };
/** A spawn that answers from a script and records what it was asked to run. */
const fake = (...answers: Array<Record<string, unknown>>) => {
	const calls: Call[] = [];
	const spawnSync = (cmd: string, args: string[], opts: Call["opts"]) => {
		calls.push({ cmd, args, opts });
		return answers.shift() ?? { status: 0 };
	};
	return { calls, spawnSync };
};
const run = (args: string[], f: ReturnType<typeof fake>, extra: Record<string, unknown> = {}) => {
	const errors: string[] = [];
	const code = runTurbo(args, { spawnSync: f.spawnSync, env: { PATH: "/bin" }, home: "/Users/me", platform: "darwin", log: (m: string) => errors.push(m), ...extra });
	return { code, errors };
};

describe("runTurbo: runs turbo through pnpm with the shared cache", () => {
	it("passes every argument through to `pnpm exec turbo`, in order", () => {
		const f = fake({ status: 0 });
		const { code } = run(["run", "build", "--filter=@wolfpack/cli", "--output-logs=errors-only"], f);
		expect(code).toBe(0);
		expect(f.calls).toHaveLength(1);
		expect(f.calls[0]!.cmd).toBe("pnpm");
		expect(f.calls[0]!.args).toEqual(["exec", "turbo", "run", "build", "--filter=@wolfpack/cli", "--output-logs=errors-only"]);
		expect(f.calls[0]!.opts.stdio).toBe("inherit");
	});
	it("sets TURBO_CACHE_DIR locally, keeping the rest of the environment", () => {
		const f = fake({ status: 0 });
		run(["run", "build"], f);
		expect(f.calls[0]!.opts.env).toMatchObject({ PATH: "/bin", TURBO_CACHE_DIR: "/Users/me/.cache/wolfpack/turbo" });
	});
	it("sets nothing in CI, which restores no turbo cache", () => {
		const f = fake({ status: 0 });
		run(["run", "build"], f, { env: { CI: "true", PATH: "/bin" } });
		expect(f.calls[0]!.opts.env.TURBO_CACHE_DIR).toBeUndefined();
	});
	it("returns the child's exit code", () => {
		expect(run(["run", "build"], fake({ status: 2 })).code).toBe(2);
	});
	it("falls back to `npx turbo` when pnpm is not on the PATH (ENOENT), and says so", () => {
		const f = fake({ error: Object.assign(new Error("spawn pnpm ENOENT"), { code: "ENOENT" }), status: null }, { status: 0 });
		const { code, errors } = run(["run", "build", "--filter=x"], f);
		expect(code).toBe(0);
		expect(f.calls.map((c) => [c.cmd, ...c.args])).toEqual([
			["pnpm", "exec", "turbo", "run", "build", "--filter=x"],
			["npx", "turbo", "run", "build", "--filter=x"],
		]);
		expect(errors.join("\n")).toContain("pnpm not found");
	});
	it("prints the spawn error and fails when neither pnpm nor npx can run", () => {
		const enoent = (c: string) => ({ error: Object.assign(new Error(`spawn ${c} ENOENT`), { code: "ENOENT" }), status: null });
		const { code, errors } = run(["run", "build"], fake(enoent("pnpm"), enoent("npx")));
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("spawn npx ENOENT");
	});
	it("prints a non-ENOENT spawn error and does not fall back", () => {
		const f = fake({ error: Object.assign(new Error("spawn pnpm EACCES"), { code: "EACCES" }), status: null });
		const { code, errors } = run(["run", "build"], f);
		expect(code).toBe(1);
		expect(f.calls).toHaveLength(1);
		expect(errors.join("\n")).toContain("EACCES");
	});
	it("reports a signal-killed child as 128 + the signal number", () => {
		const { code } = run(["run", "build"], fake({ status: null, signal: "SIGINT" }));
		expect(code).toBe(128 + os.constants.signals.SIGINT);
		expect(run(["run", "build"], fake({ status: null, signal: "SIGTERM" })).code).toBe(128 + os.constants.signals.SIGTERM);
	});
	it("uses a shell on Windows (pnpm and npx are .cmd shims there), and not elsewhere", () => {
		const win = fake({ status: 0 });
		run(["run", "build"], win, { platform: "win32" });
		expect(win.calls[0]!.opts.shell).toBe(true);
		const mac = fake({ status: 0 });
		run(["run", "build"], mac);
		expect(mac.calls[0]!.opts.shell).toBeFalsy();
	});
});
