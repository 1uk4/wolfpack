/**
 * GET/PUT /api/health/subscription: which release channel this host follows and how it updates (work-wolfpack-pr6t1Y9).
 * The file is `{schema:1, channel: stable|main, mode: off|button|auto}`; scripts/auto-update.mjs reads it. A missing or broken file
 * means stable + the host default mode (auto when WOLFPACK_AUTO_UPDATE=1 is in the console's env, else button; "unknown" when the console
 * cannot tell). On sfo-01 it lives in its own root:console 0775 directory (deploy/auto-update/setup.sh), apart from the root-only updater state dir.
 * Both verbs need the same verified-device bearer as the other pack actions (`gate`).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { subscriptionFile } from "@wolfpack/protocol/health-lag";

const CHANNELS = ["stable", "main"] as const;
const MODES = ["off", "button", "auto"] as const;
export interface Subscription {
	channel: (typeof CHANNELS)[number];
	mode: (typeof MODES)[number];
}

const NO_STORE = { "Cache-Control": "no-store" };

/** The saved subscription; invalid or missing parts fall back to stable + button. */
export function readSubscription(file: string = subscriptionFile()): Subscription {
	try {
		const s = JSON.parse(readFileSync(file, "utf8")) as Partial<Subscription> | null;
		return { channel: CHANNELS.find((c) => c === s?.channel) ?? "stable", mode: MODES.find((m) => m === s?.mode) ?? "button" };
	} catch {
		return { channel: "stable", mode: "button" };
	}
}

/** The file's contents, or null when it is missing or corrupt (callers then use the host default). */
function readFileSub(file: string): Subscription | null {
	try {
		const s = JSON.parse(readFileSync(file, "utf8")) as Partial<Subscription> | null;
		return { channel: CHANNELS.find((c) => c === s?.channel) ?? "stable", mode: MODES.find((m) => m === s?.mode) ?? "button" };
	} catch {
		return null;
	}
}

export function createSubscriptionHandler(o: { gate: (req: Request) => Promise<string | Response>; file?: string; env?: Record<string, string | undefined>; platform?: string; home?: string }) {
	const env = o.env ?? process.env;
	const file = o.file ?? subscriptionFile(env, o.platform, o.home);
	return {
		async get(req: Request): Promise<Response> {
			const g = await o.gate(req);
			if (g instanceof Response) return g;
			const s = readFileSub(file);
			if (s) return Response.json({ exists: true, ...s }, { headers: NO_STORE });
			// No usable file: the host default decides. The console may not see the updater's env file, then the mode is unknown.
			const mode = env.WOLFPACK_AUTO_UPDATE === undefined ? "unknown" : env.WOLFPACK_AUTO_UPDATE === "1" ? "auto" : "button";
			return Response.json({ exists: false, channel: "stable", mode }, { headers: NO_STORE });
		},
		async put(req: Request): Promise<Response> {
			const g = await o.gate(req);
			if (g instanceof Response) return g;
			const body = (await req.json().catch(() => null)) as Partial<Subscription> | null;
			const channel = CHANNELS.find((c) => c === body?.channel);
			const mode = MODES.find((m) => m === body?.mode);
			if (!channel || !mode) return Response.json({ error: "body must be {channel: stable|main, mode: off|button|auto}", code: "invalid_request" }, { status: 400, headers: NO_STORE });
			try {
				mkdirSync(path.dirname(file), { recursive: true });
				const tmp = `${file}.${process.pid}.tmp`;
				writeFileSync(tmp, `${JSON.stringify({ schema: 1, channel, mode })}\n`, { mode: 0o664 });
				renameSync(tmp, file);
			} catch (e) {
				return Response.json({ error: `could not save: ${(e as Error).message}`, code: "failed" }, { status: 502, headers: NO_STORE });
			}
			console.log(`console: subscription set to ${channel}/${mode} by ${g}`);
			return Response.json({ channel, mode }, { headers: NO_STORE });
		},
	};
}
