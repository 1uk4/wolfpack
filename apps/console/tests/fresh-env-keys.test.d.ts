/**
 * LH_IGNORE_ENV_KEYS=1 — the fresh-user switch (owner, interlude,
 * 2026-09-22): env keys invisible app-wide; only auth.json counts.
 *
 * This file is deliberately its OWN PROCESS under node:test: the switch
 * is BOOT-TIME (initAuthEnv deletes the managed env vars once per
 * process), so the switched boot can only be pinned in a process that
 * starts with the switch set. The UNSET behavior (env wins, fill-gap,
 * shadow semantics) is pinned byte-for-byte by tests/server-keys.test.ts
 * — that file IS the visible case; this file is the hidden one.
 *
 * The engine path is the critical subtlety this file pins: pi-ai reads
 * provider keys from process.env NATIVELY at every request
 * (auth/context.js's defaultProviderAuthContext reads live env), so the
 * switch works by DELETING the vars from the process — assert the
 * deletion directly, because that is what a fresh user's engines see.
 *
 * LH_AUTH_FILE redirects to a fresh tmp dir BEFORE the imports (the
 * seam is module-load bound). All values are throwaway test strings —
 * never real secrets.
 */
export {};
//# sourceMappingURL=fresh-env-keys.test.d.ts.map