/**
 * The auth/keys composition (auth-keys wave, 2026-09-19): the server-side
 * key manager behind GET/PUT/DELETE /api/keys.
 *
 * THE ENV SEAM (the architecture keystone): every consumer — models.ts's
 * openRouterApiKey(), the sub-agents, web.ts, the STT route — reads
 * process.env directly, and the agent layer may not import the store
 * layer. Instead of rewiring five consumers across lanes, the store
 * REFLECTS itself into the child's env: at boot (idempotent, anchored on
 * globalThis like the extraction registry) every file var UNSET in the
 * real env is fill-gapped into process.env, and each save/delete updates
 * file + env together. Keys therefore take effect immediately — no restart
 * — which is also why main.cjs's old spawn-time injection HAD to retire:
 * an env copy made at spawn would shadow every settings-page change until
 * restart (env wins over file).
 *
 * PRECEDENCE (owner decision): real environment variables (incl.
 * .env.local in dev) always win over the file. Boot-time real-env vars
 * are snapshotted once per process and never mutated; a PUT to one of
 * them persists to the file (for when the env goes away) and the status
 * honestly reports shadowedByEnv — the page explains why the saved key
 * is not the live one.
 *
 * Unknown vars in the file are preserved verbatim and surfaced as
 * generic status rows (no catalog form to edit through — only curated
 * keys have shapes and docs; core/auth-keys.ts).
 *
 * THE FRESH-USER SWITCH (owner, interlude 2026-09-22): LH_IGNORE_ENV_KEYS=1
 * makes every env key invisible APP-WIDE — the exact new-user simulation
 * (a fresh empty data dir + the switch = zero keys, zero federated
 * providers, setup stage 1). Under the switch real env vars are DELETED
 * from the process (not merely ignored by this seam): pi-ai resolves
 * provider keys from process.env NATIVELY at every request
 * (auth/context.js's defaultProviderAuthContext reads live env), so
 * deletion is the one mechanism that hides keys from every consumer —
 * model engines included. Only the file store (auth.json) counts; the
 * fill-gap still reflects file keys so a fresh user can add keys
 * mid-session and the engines see them with no restart. Unset switch =
 * today's behavior, byte-for-byte.
 */
import { type AuthKeyStatus } from "../core/auth-keys.ts";
/** Is `id` a WRITABLE key name — curated catalog or model-provider env
 *  var (provider-keys interlude: PUT/DELETE accept both). */
export declare function isWritableAuthKey(id: string): boolean;
/** The settings page's provider dropdown: every pi-ai provider that takes
 *  a plain key ({id, envVar, label} — no-drift-pinned, see the table's doc
 *  in core/auth-keys.ts and tests/auth-provider-keys.test.ts). Sorted by
 *  id for a stable payload. */
export declare function providerKeyList(): import("../core/auth-keys.ts").AuthProviderInfo[];
/** The fresh-user switch (owner, interlude 2026-09-22): env keys are
 *  invisible app-wide — deleted from the process at boot, file keys only.
 *  Read live per call (the launcher exports it before boot). */
export declare function envKeysIgnored(): boolean;
/**
 * The boot fill-gap — idempotent. First call snapshots which managed names
 * are real env; later calls (HMR re-import, or after a hand-edit) only fill
 * vars still unset in the env, so a var deleted through the API never
 * resurrects (its file entry is gone too).
 */
export declare function initAuthEnv(): void;
/**
 * The pure status projection — exported for tests. `env` is the live
 * process env view; `realEnv` the boot snapshot (env precedence).
 */
export declare function resolveKeyStatuses(fileVars: Record<string, string>, env: Record<string, string | undefined>, realEnv: ReadonlySet<string>, 
/** The model-provider env vars (provider-keys interlude): PRESENT ones
 *  join the status rows — absent ones never spam (the dropdown is the
 *  discovery surface). Curated keys always get rows, present or not. */
providerEnvVars?: ReadonlySet<string>): AuthKeyStatus[];
/** The GET view: every curated key (present or not) + unknown file vars. */
export declare function keyStatuses(): AuthKeyStatus[];
/** The live value for one var, env-first (the env-wins rule) — the canonical
 *  read for consumers that don't live behind the @/src/server barrel (the
 *  STT route was the one cold-boot hole: a first-ever request to it would
 *  otherwise read env before any fill-gap ran). */
export declare function keyValue(id: string): string | undefined;
/** The key-presence truth for one model provider (provider-key interlude,
 * 2026-09-25): would this provider's key be present at request time?
 * Reads through keyValue — the SAME env-first lookup pi-ai performs
 * natively at every request — so an env-shadowed key counts as present
 * (gate by what would run). Providers absent from AUTH_PROVIDER_KEYS take
 * no key at all: nothing to gate, present by definition. */
export declare function providerKeyPresent(provider: string): boolean;
/**
 * Save one key (PUT). Shape gate first (owner decision: bad pastes are
 * 400s, never stored), then the file write, then the env reflection. A
 * var that the REAL env owns is not reflected (env wins — the status row
 * reports shadowedByEnv so the page can explain it).
 */
export declare function saveKey(id: string, value: string): {
    ok: true;
    status: AuthKeyStatus;
} | {
    ok: false;
    error: string;
};
/**
 * Remove one key (DELETE): gone from the file always; gone from the env
 * only when the env copy was OURS (fill-gap) — a real env var stays (env
 * wins) and the status shows the key still present from env.
 */
export declare function deleteKey(id: string): AuthKeyStatus;
//# sourceMappingURL=keys.d.ts.map