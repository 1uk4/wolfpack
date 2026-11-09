/**
 * GET /api/updates: is any pack component behind the latest stable release?
 *
 * Running versions come from what the console can see on its own, never through the hub:
 *   console  its own VERSION stamp (scripts/release-version.mjs; see `consoleVersion`)
 *   hubd     GET <WOLFPACK_HUB_URL>/healthz `version`   (hub down = unknown, the rest still answers)
 *   workerd  GET <WOLFPACK_API_URL>/healthz `version`   (unset, e.g. relay mode = unknown)
 *   wolfd    unknown for now: workerd's /healthz lists wolves without versions
 * Latest versions come from the stable manifest (@wolfpack/protocol createManifestFetcher), cached there.
 *
 * Env: WOLFPACK_UPDATE_MANIFEST_URL overrides the manifest URL (a local file server for testing); "off" disables the check.
 * The prompt only names the update step and links the release notes; applying the update is work-wolfpack-qrU6cCO.
 * Auth: not gated (proxy.ts only maps the cookie to a bearer; the route checks none); fine, it returns version info and public release URLs only.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_MANIFEST_URL, checkUpdates, createManifestFetcher, probeHealth, type ManifestResult, type UpdateRow } from "@wolfpack/protocol";
import { stampedVersion } from "@wolfpack/protocol/health-lag";

export interface UpdateComponent extends UpdateRow {
	/** What to do to update this component (shown with the notice). */
	updateStep: string;
}

export interface UpdatesBody {
	checkedAt: string;
	/** true when at least one component is known to be behind. */
	outdated: boolean;
	components: UpdateComponent[];
	/** Why the manifest could not be read (fresh); the rows then carry `latest: null` unless an older manifest was cached. */
	manifestError?: string;
}

const STEPS: Record<string, string> = {
	console: "Deploy the console release to sfo-01 (deploy/console/RUNBOOK.md); on the Mac, pnpm runtime:update.",
	hubd: "Deploy the hubd release to sfo-01 (deploy/hubd/RUNBOOK.md).",
	workerd: "On the Mac: pnpm runtime:update, then pnpm stack restart.",
	wolfd: "On the Mac: pnpm runtime:update, then pnpm stack restart (sfo-01 wolves: deploy the wolfd release).",
};

/**
 * The console's release version. `dir` is the server's working directory: apps/console under `next dev` / `next start`
 * (`pnpm runtime:update` stamps apps/console/VERSION), and <payload>/apps/console in a release bundle, where the standalone server
 * chdirs and the stamp sits two levels up (<payload>/VERSION, scripts/build-server.mjs). Else <package.json>-dev.
 */
export function consoleVersion(dir: string = process.cwd()): string | undefined {
	// Runtime files beside the server, not build inputs: keep the file tracer from pulling in the whole cwd.
	const u = (...p: string[]) => pathToFileURL(path.join(/*turbopackIgnore: true*/ dir, ...p));
	return stampedVersion([u("VERSION"), u("..", "..", "VERSION")], u("package.json"));
}

export interface UpdatesOptions {
	env?: Record<string, string | undefined>;
	consoleDir?: string;
	probeTimeoutMs?: number;
	/** The manifest reader (default: one built from the env, cached for the life of the handler). */
	manifest?: () => Promise<ManifestResult>;
}

const base = (u: string | undefined) => u?.trim().replace(/\/+$/, "") || undefined;

async function serviceVersion(url: string | undefined, service: string, timeoutMs: number): Promise<string | undefined> {
	if (!url) return undefined;
	const r = await probeHealth(`${url}/healthz`, { expectService: service, timeoutMs });
	return r.status !== "down" && typeof r.body?.version === "string" ? r.body.version : undefined;
}

export function createUpdatesHandler(o: UpdatesOptions = {}): () => Promise<UpdatesBody> {
	const env = o.env ?? process.env;
	const url = env.WOLFPACK_UPDATE_MANIFEST_URL?.trim() || DEFAULT_MANIFEST_URL;
	const off = url === "off";
	const manifest = o.manifest ?? (off ? async (): Promise<ManifestResult> => ({ manifest: null, error: "update check is off (WOLFPACK_UPDATE_MANIFEST_URL=off)" }) : createManifestFetcher({ url }));
	const timeoutMs = o.probeTimeoutMs ?? 3_000;
	const own = consoleVersion(o.consoleDir);
	return async () => {
		const [m, hubd, workerd] = await Promise.all([
			manifest(),
			serviceVersion(base(env.WOLFPACK_HUB_URL), "hubd", timeoutMs),
			serviceVersion(base(env.WOLFPACK_API_URL), "workerd", timeoutMs),
		]);
		const rows = checkUpdates(m.manifest, { console: own, hubd, workerd, wolfd: undefined });
		const components = rows.map((r) => ({ ...r, updateStep: STEPS[r.component] ?? "" }));
		return {
			checkedAt: new Date().toISOString(),
			outdated: components.some((c) => c.outdated === true),
			components,
			...(m.error ? { manifestError: m.error } : {}),
		};
	};
}
