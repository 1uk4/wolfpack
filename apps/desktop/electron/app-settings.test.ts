/**
 * Seams: createAppSettings (electron/app-settings.cjs), driven with temp dirs, a fake Anthropic server on 127.0.0.1 and stand-ins for
 * Electron's shell / clipboard / app. No Electron, no real services.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const { createAppSettings } = createRequire(import.meta.url)("./app-settings.cjs");

let fake: Server;
let fakeUrl: string;
let root: string;
let state: string;
let wolves: string;
let clip: string[];
let calls: string[];
let trashFails: boolean;
let confirmAnswer: boolean;
let opened: string[];

beforeAll(async () => {
	fake = createServer((req, res) => {
		const ok = req.headers["x-api-key"] === "sk-new-good";
		res.writeHead(ok ? 200 : 401, { "content-type": "application/json" }).end("{}");
	});
	await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
	fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
});
afterAll(async () => {
	await new Promise((r) => fake?.close(r));
});

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "app-settings-"));
	state = join(root, "Wolfpack");
	wolves = join(root, "Wolves");
	mkdirSync(join(state, "logs"), { recursive: true });
	mkdirSync(join(wolves, "mine"), { recursive: true });
	writeFileSync(join(wolves, "mine", "wolf.yaml"), "id: mine\n");
	writeFileSync(join(state, "credentials.json"), JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-old-key-0000" }), { mode: 0o600 });
	writeFileSync(join(state, "hub-token.json"), JSON.stringify({ token: "hubtok-abc123" }));
	clip = [];
	calls = [];
	trashFails = false;
	confirmAnswer = true;
	opened = [];
});

function make(o: { wolves?: string; confirm?: () => Promise<boolean> } = {}) {
	const sup = {
		urls: {},
		status: () => ({ running: true }),
		stop: async () => void calls.push("stop"),
		start: async () => void calls.push("start"),
		restart: async (n: string) => void calls.push(`restart:${n}`),
	};
	const settings = createAppSettings({
		stateDir: state,
		wolvesDir: o.wolves ?? wolves,
		confirm: o.confirm ?? (async () => confirmAnswer),
		getSup: () => sup,
		modelBaseUrl: fakeUrl,
		version: "1.2.3",
		log: () => {},
		clipboard: { writeText: (t: string) => void clip.push(t) },
		shell: {
			openPath: async (p: string) => (opened.push(p), ""),
			trashItem: async (p: string) => {
				if (trashFails) throw new Error("no trash");
				mkdirSync(join(root, "Trash"), { recursive: true });
				// Move, like the real Trash: nothing is deleted.
				const { renameSync } = await import("node:fs");
				renameSync(p, join(root, "Trash", "Wolfpack"));
				calls.push("trash");
			},
		},
		app: {
			getLoginItemSettings: () => ({ openAtLogin: false }),
			setLoginItemSettings: () => {},
			relaunch: () => void calls.push("relaunch"),
			exit: () => void calls.push("exit"),
		},
	});
	return settings;
}

describe("diagnostics", () => {
	it("copies a report with no key, token, Bearer header or JSON apiKey, and keeps the surrounding text", async () => {
		writeFileSync(
			join(state, "logs", "main.log"),
			[
				"started fine",
				"using key sk-ant-old-key-0000 for calls",
				"hub said hubtok-abc123 ok",
				"Authorization header was Bearer abc.DEF-123_xyz",
				'sent {"apiKey":"sk-other-secret-9999","model":"haiku"}',
				"x-api-key: sk-proj-zzzzzz111",
				"disk-usage-report risk-assessment task-queue-worker",
				"see sk-proj-abc123def456 here",
				'headers {"x-wolfpack-direct-token": "jsonhdr-5150"}',
				"launched with TOKEN=baretok-4242 and more",
			"x-wolfpack-direct-token: dtok-1a2b3c4d",
			"GET /v1/wolves?token=urltok-111&x=1 and /x?a=2&token=urltok-222",
			"config token: plaintok-333 apiKey: plainkey-444 password: plainpw-555",
			"ANTHROPIC_API_KEY=envkey-666 HUB_TOKEN=envtok-777 STRIPE_KEY=envkey-888",
			"POST https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage",
			"bare 987654321:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsawXY",
			"pairing code: PAIR-9999-ZZ",
			`long ${"a".repeat(3000)}END`,
				"last line",
			].join("\n"),
		);
		expect(await make().copyDiagnostics()).toEqual({ ok: true });
		const text = clip[0];
		for (const secret of ["sk-ant-old-key-0000", "hubtok-abc123", "abc.DEF-123_xyz", "sk-other-secret-9999", "sk-proj-zzzzzz111", "dtok-1a2b3c4d", "urltok-111", "urltok-222", "plaintok-333", "plainkey-444", "plainpw-555", "envkey-666", "envtok-777", "envkey-888", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", "BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsawXY", "PAIR-9999-ZZ", "sk-proj-abc123def456", "jsonhdr-5150", "baretok-4242"]) {
			expect(text).not.toContain(secret);
		}
		expect(text).toContain("started fine");
		expect(text).toContain("disk-usage-report risk-assessment task-queue-worker");
		expect(text).toContain('"model":"haiku"');
		expect(text).toContain("last line");
		expect(text).toContain("/sendMessage");
		expect(text).not.toContain("END"); // each line is cut at 2,000 characters
		expect(Math.max(...text.split("\n").map((l: string) => l.length))).toBeLessThanOrEqual(2001);
		expect(text).toContain("App version: 1.2.3");
	});
});

describe("reset", () => {
	it("moves the app data to the Trash, relaunches, and leaves the wolves folder intact", async () => {
		expect(await make().reset()).toEqual({ ok: true });
		expect(existsSync(state)).toBe(false);
		expect(existsSync(join(root, "Trash", "Wolfpack", "credentials.json"))).toBe(true);
		expect(readFileSync(join(wolves, "mine", "wolf.yaml"), "utf8")).toBe("id: mine\n");
		expect(calls.indexOf("trash")).toBeGreaterThanOrEqual(0);
		expect(calls.indexOf("trash")).toBeLessThan(calls.indexOf("relaunch"));
	});

	it("does nothing when the native confirm is cancelled", async () => {
		confirmAnswer = false;
		expect(await make().reset()).toEqual({ ok: false, cancelled: true });
		expect(existsSync(join(state, "credentials.json"))).toBe(true);
		expect(calls).toEqual([]);
	});

	it("refuses a second reset or key change while a confirm is still open", async () => {
		let asked = 0;
		const s = make({ confirm: () => (asked++, new Promise<boolean>(() => {})) });
		void s.reset();
		expect(await s.reset()).toEqual({ ok: false, busy: true });
		expect(await s.changeKey("sk-new-good")).toEqual({ ok: false, busy: true });
		expect(asked).toBe(1);
	});

	it("refuses when the wolves folder and the app data folder are nested", async () => {
		mkdirSync(join(state, "Wolves"), { recursive: true });
		const r = await make({ wolves: join(state, "Wolves") }).reset();
		expect(r.ok).toBe(false);
		expect(existsSync(join(state, "credentials.json"))).toBe(true);
		expect(calls).toEqual([]);
	});

	it("keeps everything and restarts the services when the Trash fails", async () => {
		trashFails = true;
		const r = await make().reset();
		expect(r.ok).toBe(false);
		expect(r.error).toContain("Nothing was changed");
		expect(existsSync(join(state, "credentials.json"))).toBe(true);
		expect(existsSync(join(wolves, "mine", "wolf.yaml"))).toBe(true);
		expect(calls).toEqual(["stop", "start"]);
	});
});

describe("show folder", () => {
	it("opens only the two known folders, never a path or a prototype name from the page", async () => {
		expect((await make().showFolder("/etc")).ok).toBe(false);
		expect((await make().showFolder("__proto__")).ok).toBe(false);
		expect(opened).toEqual([]);
		expect((await make().showFolder("wolves")).ok).toBe(true);
		expect(opened).toEqual([wolves]);
	});
});

describe("change key", () => {
	it("keeps the other fields in credentials.json when the key changes", async () => {
		writeFileSync(join(state, "credentials.json"), JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-old-key-0000", EXTRA: "keepme" }), { mode: 0o600 });
		expect(await make().changeKey("sk-new-good")).toEqual({ ok: true });
		expect(JSON.parse(readFileSync(join(state, "credentials.json"), "utf8"))).toEqual({ ANTHROPIC_API_KEY: "sk-new-good", EXTRA: "keepme" });
	});

	it("does not test the key against Anthropic when the confirm is cancelled", async () => {
		confirmAnswer = false;
		let checks = 0;
		const s = createAppSettings({ stateDir: state, wolvesDir: wolves, confirm: async () => false, getSup: () => ({ restart: async () => {} }), fetchImpl: async () => (checks++, new Response("{}")), log: () => {}, version: "1", clipboard: { writeText: () => {} }, shell: {}, app: {} });
		expect(await s.changeKey("sk-new-good")).toEqual({ ok: false, cancelled: true });
		expect(checks).toBe(0);
	});

	it("leaves credentials.json alone when Anthropic refuses the key", async () => {
		const before = readFileSync(join(state, "credentials.json"), "utf8");
		expect(await make().changeKey("sk-ant-bad")).toEqual({ ok: false, error: "That key didn't work" });
		expect(readFileSync(join(state, "credentials.json"), "utf8")).toBe(before);
		expect(calls).toEqual([]);
	});

	it("writes an accepted key at 0600 and restarts only the wolf, never returning the key", async () => {
		const r = await make().changeKey("sk-new-good");
		expect(r).toEqual({ ok: true });
		expect(JSON.parse(readFileSync(join(state, "credentials.json"), "utf8"))).toEqual({ ANTHROPIC_API_KEY: "sk-new-good" });
		expect(statSync(join(state, "credentials.json")).mode & 0o777).toBe(0o600);
		expect(calls).toEqual(["restart:wolfd"]);
	});
});
