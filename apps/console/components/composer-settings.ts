/**
 * The composer controls' state logic (pure, no React): the per-thread settings the wolf keeps (model tier, auto-ship),
 * the optimistic change with rollback, and the fetch seams. The component (composer-controls.tsx) only renders.
 */

export type Tier = "main" | "smart" | "fast";
export const TIERS: readonly Tier[] = ["main", "smart", "fast"];

export interface ThreadSettingsState {
	tier: Tier;
	autoShip: boolean;
	/** The model each tier resolves to on this wolf (a hint beside the picker). */
	models?: Partial<Record<Tier, string>>;
}

export const DEFAULT_SETTINGS: ThreadSettingsState = { tier: "main", autoShip: false };

export type SettingsPatch = Partial<Pick<ThreadSettingsState, "tier" | "autoShip">>;
type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

async function failureOf(res: Response): Promise<Error> {
	const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
	return new Error(body?.error ?? body?.message ?? `settings request failed (${res.status})`);
}

export async function fetchSettings(url: string, fetchFn: FetchFn = fetch): Promise<ThreadSettingsState> {
	const res = await fetchFn(url);
	if (!res.ok) throw await failureOf(res);
	return (await res.json()) as ThreadSettingsState;
}

export async function putSettings(url: string, patch: SettingsPatch, fetchFn: FetchFn = fetch): Promise<ThreadSettingsState> {
	const res = await fetchFn(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
	if (!res.ok) throw await failureOf(res);
	return (await res.json()) as ThreadSettingsState;
}

/**
 * Apply a change optimistically: `set` shows it at once, `put` sends it; if the wolf refuses, ONLY the fields this
 * change touched go back to what they were (a later change to the other field is left alone) and the error is returned.
 */
export async function changeSettings(args: {
	current: ThreadSettingsState;
	patch: SettingsPatch;
	put: (patch: SettingsPatch) => Promise<ThreadSettingsState>;
	set: (update: (s: ThreadSettingsState) => ThreadSettingsState) => void;
}): Promise<{ ok: true } | { ok: false; error: string }> {
	const { current, patch, put, set } = args;
	const before: SettingsPatch = {};
	if (patch.tier !== undefined) before.tier = current.tier;
	if (patch.autoShip !== undefined) before.autoShip = current.autoShip;
	set((s) => ({ ...s, ...patch }));
	try {
		const stored = await put(patch);
		// The model hints may be news; the choice itself stays as the operator made it.
		if (stored.models) set((s) => ({ ...s, models: stored.models }));
		return { ok: true };
	} catch (e) {
		set((s) => ({ ...s, ...before }));
		return { ok: false, error: e instanceof Error ? e.message : "could not save the setting" };
	}
}
