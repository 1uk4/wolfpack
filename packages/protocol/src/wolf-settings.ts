/**
 * The per-wolf settings API over /v1/wolves/:name/settings: the wolf's wolf.yaml (secrets masked), the environment variable NAMES it
 * reads (never values), a validated write and a restart. Also the secret masking shared with hubd's settings.
 */
import { z } from "zod";

/** Option names that hold a credential (key, token, secret, password, ...). */
export const SECRET_KEY = /token|secret|passw(or)?d|passphrase|credential|api[-_]?key|bearer|private[-_]?key|cookie/i;
/** A URL with userinfo (`https://user:pw@host`) is a credential too. */
const URL_WITH_USERINFO = /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]*@/i;

/** Copy `value` with every secret replaced by `{ set: boolean }`; functions and undefined are dropped (test seams, absent options). */
export function maskSecrets(value: unknown, key = ""): unknown {
  if (typeof value === "function" || value === undefined) return undefined;
  if (key && SECRET_KEY.test(key) && (value === null || typeof value !== "object")) return { set: value !== null && value !== "" && value !== false };
  if (typeof value === "string" && URL_WITH_USERINFO.test(value)) return { set: true };
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k) && v && typeof v === "object" && !Array.isArray(v)) { out[k] = { set: true }; continue; }
      const m = maskSecrets(v, k);
      if (m !== undefined) out[k] = m;
    }
    return out;
  }
  return value;
}

/** Whether a config option named by its dotted key is masked by `maskSecrets` (any path segment matches the secret pattern, or the value is a user:pw@ URL). */
export function isMaskedConfigKey(dotted: string, value: unknown): boolean {
  return dotted.split(".").some((seg) => SECRET_KEY.test(seg)) || (typeof value === "string" && URL_WITH_USERINFO.test(value));
}

/** Whether a value (a config option or an environment variable named `key`) is secret and must be masked. */
export function isSecretValue(key: string, value: unknown): boolean {
  return (SECRET_KEY.test(key) && typeof value !== "object") || (typeof value === "string" && URL_WITH_USERINFO.test(value));
}

/** An environment variable the wolf reads: its name and whether it is set, never its value. */
export const EnvVarViewSchema = z.object({
  name: z.string(),
  set: z.boolean(),
  /** Its value is a credential: only `revealWolfSetting` returns it. */
  secret: z.boolean(),
  /** What it configures. */
  purpose: z.string(),
});
export type EnvVarView = z.infer<typeof EnvVarViewSchema>;

export const WolfSettingsViewSchema = z.object({
  /** Hash of the wolf.yaml text: send as If-Match on PUT. */
  etag: z.string(),
  /** wolf.yaml as parsed from disk now, secrets masked as `{set}`. */
  config: z.record(z.string(), z.unknown()),
  /** The dotted keys PUT accepts (`subagents.maxRunning`, `models.fast.model`, ...). */
  editable: z.array(z.string()),
  /** The model each tier resolved to when this wolfd started. */
  tierModels: z.record(z.string(), z.string()),
  /** The pi provider each tier resolved to when this wolfd started ("anthropic", "claude-stateless", "openai", ...). Absent on older wolves. */
  tierProviders: z.record(z.string(), z.string()).optional(),
  env: z.array(EnvVarViewSchema),
  /** The file changed since wolfd started: the running wolf still has the old values. */
  restartNeeded: z.boolean(),
  /** A supervisor will start this wolfd again after restart; false: `restartWolf` is refused. */
  restartable: z.boolean(),
  /** Seconds until `restartWolf` is accepted (0 = now). A restart within the first minute of the process is refused. */
  restartAvailableInSeconds: z.number().int().nonnegative(),
});
export type WolfSettingsView = z.infer<typeof WolfSettingsViewSchema>;

/** `set`: dotted key -> new value (null removes the key). Only keys in `editable`. */
export const PutWolfSettingsBodySchema = z.object({ set: z.record(z.string(), z.unknown()) });
export type PutWolfSettingsBody = z.infer<typeof PutWolfSettingsBodySchema>;

export const RevealBodySchema = z.object({
  /** `env`: an environment variable listed in the view; `config`: a dotted key of wolf.yaml. */
  source: z.enum(["env", "config"]),
  name: z.string().min(1),
});
export type RevealBody = z.infer<typeof RevealBodySchema>;
export const RevealResponseSchema = z.object({ name: z.string(), value: z.string().nullable() });
export type RevealResponse = z.infer<typeof RevealResponseSchema>;

export const RestartResponseSchema = z.object({ restarting: z.literal(true) });
export type RestartResponse = z.infer<typeof RestartResponseSchema>;
