/**
 * The keys composition (auth-keys wave, 2026-09-19): env-reflecting store +
 * env-wins precedence + the masked status view. Owner decisions pinned:
 *  - real env always wins; a PUT to an env-owned var persists to the file
 *    but never overwrites the env copy (status reports shadowedByEnv);
 *  - saves/deletes take effect immediately (file + process.env together);
 *  - unknown file vars are preserved and surfaced, never editable.
 *
 * LH_AUTH_FILE redirects to a fresh tmp dir BEFORE the imports (the seam is
 * module-load bound); the \"real env\" var is set before src/server/keys.ts
 * first loads so the boot snapshot treats it as real environment. All
 * values here are throwaway test strings — never real secrets.
 */
export {};
//# sourceMappingURL=server-keys.test.d.ts.map