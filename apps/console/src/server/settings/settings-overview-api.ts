/**
 * THE SETTINGS OVERVIEW: one read for the Settings/Prompts UI. For the hub (GET /v1/settings) and every wolf the hub lists
 * (GET /v1/wolves/:name/prompts, tunnelled to remote hosts by the hubd relay) it collects what each answers, plus the compaction
 * prompts and where they run. Every call goes through the request-scoped client (getConsoleClient), so it carries the browser's own
 * device token; WOLFPACK_HUB_TOKEN is never used. Wolves are fetched in parallel, each under a timeout; one that fails, is offline or
 * times out carries `error` and the response still succeeds.
 */
import type { ConsoleClient, HubSettings, PromptView, WolfSettingsView } from "@wolfpack/client";
import { HUB_AUTH_HEADER } from "../../core/ui/hub-auth.ts";
import { getConsoleClient, isHubAuthError } from "../thread/console-client.ts";
import type { ClientSource } from "../thread/thread-api.ts";

export interface CompactionPromptInfo {
	id: string;
	label: string;
	/** What starts it. */
	triggers: ("auto" | "manual")[];
	/** The process that makes the summarizing call. */
	runsIn: "console" | "wolf";
	/** Where the text lives in the repo or its dependency. */
	source: string;
	/** The exact text, or null when only the wolf's process can read it (the console does not depend on that package). */
	text: string | null;
	note: string;
}

export interface WolfSettings {
	name: string;
	host?: string;
	online?: boolean;
	prompts?: PromptView[];
	error?: string;
	/** The wolf's wolfd GET /settings (secrets masked, env names only). */
	config?: WolfSettingsView;
	configError?: string;
}

export interface SettingsOverview {
	hub: { ok: boolean; settings?: HubSettings; error?: string };
	wolves: WolfSettings[];
	/** Set when the wolf list itself could not be fetched (hub or wolf unreachable): `wolves` is then empty. An auth failure is not reported here; it answers 401. */
	wolvesError?: string;
	compaction: { prompts: CompactionPromptInfo[] };
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
	});
	return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** pi-durable's compaction text as a wolf reports it (read from its installed package): system prompt, then the instructions. Null when no wolf answered with it. */
function piDurableText(wolves: WolfSettings[]): string | null {
	for (const w of wolves) {
		const system = w.prompts?.find((p) => p.id === "compaction.pi-durable-system")?.text;
		const instructions = w.prompts?.find((p) => p.id === "compaction.pi-durable-instructions")?.text;
		if (system !== undefined && instructions !== undefined) return `${system}\n\n---\n\n${instructions}`;
	}
	return null;
}

export function compactionPrompts(wolves: WolfSettings[] = []): CompactionPromptInfo[] {
	return [
		{
			id: "pi-durable-summarizer",
			label: "Wolf compaction (pi-durable): summarization system prompt and instructions",
			triggers: ["auto", "manual"],
			runsIn: "wolf",
			source: "@earendil-works/pi-durable/dist/harness/compaction.js (SUMMARIZATION_SYSTEM_PROMPT, SUMMARIZATION_PROMPT)",
			text: piDurableText(wolves),
			note: "wolfd's engine compacts every wolf thread, including hal's: automatically past the thresholds (packages/harness/src/engine/compaction.ts) and on POST /v1/threads/:id/compact (wolfd/server.ts compactThread). The text is the one the wolf reads from its installed pi-durable (system prompt, a rule, then the instructions), taken from the wolf's prompts as compaction.pi-durable-system and compaction.pi-durable-instructions; null when no wolf answered.",
		},
	];
}

export function createSettingsOverviewApi(source: ClientSource, opts: { wolfTimeoutMs?: number } = {}) {
	const timeoutMs = opts.wolfTimeoutMs ?? 8000;
	async function overview(c: ConsoleClient): Promise<SettingsOverview> {
		// A revoked/missing token must reach the route (401 + marker), not become a per-section error string.
		let authLost: unknown;
		const note = (e: unknown): string => {
			if (isHubAuthError(e)) authLost ??= e;
			return errText(e);
		};
		const hubP: Promise<SettingsOverview["hub"]> = c.getHubSettings
			? withTimeout(c.getHubSettings(), timeoutMs).then((settings) => ({ ok: true, settings }), (e) => ({ ok: false, error: note(e) }))
			: Promise.resolve({ ok: false, error: "hub settings are not available on this console (no hub configured)" });
		let wolves: Awaited<ReturnType<ConsoleClient["listWolves"]>> = [];
		let wolvesError: string | undefined;
		try {
			wolves = await c.listWolves();
		} catch (e) {
			if (e instanceof Error && e.name === "ProtocolError" && (e as Error & { code?: string }).code === "unauthorized") throw e; // unpaired browser: the route answers 401
			wolvesError = errText(e);
		}
		const wolvesP = Promise.all(
			wolves.map(async (w): Promise<WolfSettings> => {
				const base: WolfSettings = { name: w.name, host: w.host, online: w.status !== "offline" };
				const cfgP = c.getWolfSettings
					? withTimeout(c.getWolfSettings(w.name), timeoutMs).then((config) => ({ config }), (e) => ({ configError: note(e) }))
					: Promise.resolve({ configError: "wolf settings are not available on this console" });
				if (!c.listPrompts) return { ...base, ...(await cfgP), error: "prompts are not available on this console" };
				try {
					const [prompts, cfg] = await Promise.all([withTimeout(c.listPrompts(w.name), timeoutMs), cfgP]);
					return { ...base, prompts, ...cfg };
				} catch (e) {
					return { ...base, ...(await cfgP), error: note(e) };
				}
			}),
		);
		const [hub, wolfList] = await Promise.all([hubP, wolvesP]);
		if (authLost) throw authLost;
		return { hub, wolves: wolfList, ...(wolvesError ? { wolvesError } : {}), compaction: { prompts: compactionPrompts(wolfList) } };
	}
	return {
		async overview(): Promise<Response> {
			try {
				return Response.json(await overview(source()));
			} catch (err) {
				if (err instanceof Error && err.name === "ProtocolError") {
					const hubAuth = (err as Error & { hubAuth?: boolean }).hubAuth === true;
					const code = (err as Error & { code?: string }).code ?? "engine_error";
					return Response.json({ error: err.message, code }, { status: code === "unauthorized" ? 401 : 502, ...(hubAuth ? { headers: { [HUB_AUTH_HEADER]: "required" } } : {}) });
				}
				console.error("[settings-overview] unexpected error:", err);
				return Response.json({ error: "Internal error" }, { status: 500 });
			}
		},
	};
}

export const settingsOverviewApi = (): ReturnType<typeof createSettingsOverviewApi> => createSettingsOverviewApi(getConsoleClient);
