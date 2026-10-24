/**
 * The AuthStore adapter (auth-keys wave, 2026-09-19): the flat {VAR: value}
 * auth.json map at config.AUTH_FILE — the SAME file the Electron app has
 * always hand-edited (owner decision: option A — same file, env-located,
 * zero migration). 0600, atomic writes, hand-edits keep working (the file
 * is re-read from disk on every access).
 *
 * The server (src/server/keys.ts) is the only intended writer: it applies
 * shape validation before setAuthVar and env precedence on top of
 * authVars(). This adapter persists what it is given, never throws
 * (absent/corrupt file = {} = "no keys yet", the documented first-boot
 * state, matching settings doctrine), and preserves unknown vars verbatim
 * (forward-compat: future entries — e.g. a plans-login token — ride along
 * untouched until a catalog entry adopts them).
 */
import type { AuthStore } from "../core/ports.ts";
export declare const authStore: AuthStore;
//# sourceMappingURL=auth.d.ts.map