/**
 * The Mac's local service probe (work-wolfpack-cMO1WtU): is hubd / workerd on THIS machine answering, and which version.
 * Same targets as the pack monitor (hubTarget / healthTargets: env overrides, else 127.0.0.1 on the runtime's default ports),
 * so it never needs WOLFPACK_HUB_URL / WOLFPACK_API_URL to be set. Used by the update check on a Mac console, and by the Mac
 * memory-keys state (work-wolfpack-sCTDiDN). Never throws: a service that does not answer is `{ up: false, version: null }`.
 */
import { probeHealth } from "@wolfpack/protocol";
import { healthTargets, hubTarget } from "./pack-health.ts";

export interface LocalServiceProbe {
	up: boolean;
	version: string | null;
}
export interface MacLocalServices {
	hubd: LocalServiceProbe;
	workerd: LocalServiceProbe;
}

async function one(url: string | undefined, service: string, timeoutMs: number): Promise<LocalServiceProbe> {
	if (!url) return { up: false, version: null };
	try {
		const r = await probeHealth(url, { expectService: service, timeoutMs });
		if (r.status === "down") return { up: false, version: null };
		return { up: true, version: typeof r.body?.version === "string" ? r.body.version : null };
	} catch {
		return { up: false, version: null };
	}
}

export async function probeMacLocalServices(env: Record<string, string | undefined> = process.env, o: { timeoutMs?: number } = {}): Promise<MacLocalServices> {
	const timeoutMs = o.timeoutMs ?? 3_000;
	const [hubd, workerd] = await Promise.all([
		one(hubTarget(env).healthz, "hubd", timeoutMs),
		one(healthTargets(env).workerds[0]?.url, "workerd", timeoutMs),
	]);
	return { hubd, workerd };
}
