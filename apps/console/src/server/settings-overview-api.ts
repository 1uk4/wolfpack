/**
 * THE SETTINGS OVERVIEW: one read for the Settings/Prompts UI. For the hub (GET /v1/settings) and every wolf the hub lists
 * (GET /v1/wolves/:name/prompts, tunnelled to remote hosts by the hubd relay) it collects what each answers, plus the compaction
 * prompts and where they run. Every call goes through the request-scoped client (getConsoleClient), so it carries the browser's own
 * device token; WOLFPACK_HUB_TOKEN is never used. Wolves are fetched in parallel, each under a timeout; one that fails, is offline or
 * times out carries `error` and the response still succeeds. A per-wolf `config` field is reserved for wolfd's /settings (not built yet).
 */
import type { ConsoleClient, HubSettings, PromptView } from "@wolfpack/client";
import { HUB_AUTH_HEADER } from "../core/hub-auth.ts";
import { buildCompactionPrompt } from "../core/compaction.ts";
import { SUMMARIZER_SYSTEM_PROMPT } from "./compaction.ts";
import { getConsoleClient } from "./console-client.ts";
import type { ClientSource } from "./thread-api.ts";

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
	// config?: reserved for wolfd GET /settings (work-wolfpack-MrpUI1m)
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
			id: "console-auto-summarizer",
			label: "Console auto-compaction: summarizer system prompt",
			triggers: ["auto"],
			runsIn: "console",
			source: "apps/console/src/server/compaction.ts SUMMARIZER_SYSTEM_PROMPT",
			text: SUMMARIZER_SYSTEM_PROMPT,
			note: "Used by the console's own chat handler (POST /api/chat: ensureCompacted / kickCompaction). That path is not reachable from the current UI (every thread view passes a wolf thread transport); wolf threads are compacted by wolfd.",
		},
		{
			id: "console-auto-instructions",
			label: "Console auto-compaction: summary instructions ({{span}} = the transcript span)",
			triggers: ["auto"],
			runsIn: "console",
			source: "apps/console/src/core/compaction.ts buildCompactionPrompt",
			text: buildCompactionPrompt({ spanText: "{{span}}" }),
			note: "The user message of the console summarizer call, with the span placeholder left in.",
		},
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
		const hubP: Promise<SettingsOverview["hub"]> = c.getHubSettings
			? withTimeout(c.getHubSettings(), timeoutMs).then((settings) => ({ ok: true, settings }), (e) => ({ ok: false, error: errText(e) }))
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
				if (!c.listPrompts) return { ...base, error: "prompts are not available on this console" };
				try {
					return { ...base, prompts: await withTimeout(c.listPrompts(w.name), timeoutMs) };
				} catch (e) {
					return { ...base, error: errText(e) };
				}
			}),
		);
		const [hub, wolfList] = await Promise.all([hubP, wolvesP]);
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
