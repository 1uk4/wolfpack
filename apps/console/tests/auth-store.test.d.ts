/**
 * The AuthStore fs adapter (auth-keys wave, 2026-09-19) — flat {VAR: value}
 * map at config.AUTH_FILE. THIS FILE is the sole owner of its auth file:
 * LH_AUTH_FILE is redirected to a fresh tmp dir BEFORE the first config
 * import (the seam is module-load-bound — data-dir-seam precedent), so no
 * hand-edited dev/desktop auth.json is ever touched.
 *
 * Pinning: absent/corrupt = {} ("no keys yet"); set/delete round-trip with
 * unknown vars preserved verbatim; the file is ALWAYS mode 0600 (secrets);
 * writes are atomic (tmp+rename — no partial JSON state).
 */
export {};
//# sourceMappingURL=auth-store.test.d.ts.map