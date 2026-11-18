/** The per-wolf settings store behind /v1/wolves/:name/settings: reads wolf.yaml, validates and atomically writes edits, names env vars. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { atomicWrite, backupFile } from "@wolfpack/agents";
import { WolfFileSchema } from "@wolfpack/engine";
import { THREAD_COLOR_KEYS, isMaskedConfigKey, isSecretValue, maskSecrets, type EnvVarView } from "@wolfpack/protocol";
import { isMap, parse as parseYaml, parseDocument } from "yaml";

/** wolf.yaml keys an edit may set (dotted). Everything else (memory.live, librarian, identity, serve, sandbox, ...) stays hand-edited. */
export const EDITABLE_KEYS: readonly string[] = [
  ...(["main", "smart", "fast"] as const).flatMap((t) => [`models.${t}.provider`, `models.${t}.model`, `models.${t}.thinking`, `tiers.${t}.model`, `tiers.${t}.thinking`]),
  "color",
  "prompts.structuredOutput",
  "subagents.maxRunning",
  "compaction.enabled",
  "compaction.startAt",
  "compaction.reserveTokens",
  "compaction.keepRecentTokens",
  "memory.defaultDomain",
  "memory.model",
  "memory.sweepInterval",
  "memory.consolidation.threshold",
  "memory.consolidation.poolTarget",
  "memory.consolidation.maxTopics",
  "memory.consolidation.trigger",
  "memory.consolidation.interval",
];

/** Environment variables wolfd reads, by name. */
const ENV_VARS: ReadonlyArray<{ name: string; purpose: string }> = [
  { name: "WORK_ENDPOINT", purpose: "Work API base URL" },
  { name: "WORK_TOKEN", purpose: "Work API token" },
  { name: "WOLFPACK_HUB_KB", purpose: "hub-KB mode (set to 1)" },
  { name: "WOLFPACK_HUB_URL", purpose: "hub URL for the KB sync and work proxy" },
  { name: "WOLFPACK_HUB_TOKEN", purpose: "hub worker token" },
  { name: "KB_BASE", purpose: "KB root (read)" },
  { name: "KB_OPS", purpose: "KB ops root (inbox, state)" },
  { name: "CLAUDE_CODE_OAUTH_TOKEN", purpose: "Claude subscription token for the engine" },
  { name: "ANTHROPIC_API_KEY", purpose: "metered key; a wolfd wolf must not set it" },
  { name: "WOLFPACK_SUBAGENT_HOST_MAX", purpose: "subagents running at once across this host" },
  { name: "WOLFPACK_SUBAGENT_SLOTS", purpose: "host subagent slot directory" },
  { name: "WOLFPACK_SUBAGENT_SLOT_POLL_MS", purpose: "slot poll interval (ms)" },
  { name: "WOLFPACK_STALL_TIMEOUT_MS", purpose: "turn stall timeout (ms)" },
];

export class SettingsError extends Error {
  constructor(readonly code: "invalid_request" | "conflict" | "not_found", message: string) {
    super(message);
  }
}

const etagOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

export class WolfSettingsStore {
  private readonly bootEtag: string;
  constructor(private readonly file: string, private readonly env: NodeJS.ProcessEnv = process.env, private readonly wolfHome: string = dirname(file)) {
    this.bootEtag = etagOf(this.text());
  }
  private text(): string {
    try {
      return readFileSync(this.file, "utf8");
    } catch {
      return "";
    }
  }
  private doc(): Record<string, unknown> {
    let d: unknown;
    try {
      d = parseYaml(this.text());
    } catch {
      return {}; // a syntax error: the view still answers (with its etag); a write is refused
    }
    return d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
  }

  view(tierModels: Record<string, string>, restartable: boolean, restartAvailableInSeconds: number, wolfName?: string, tierProviders?: Record<string, string>) {
    const text = this.text();
    const config = maskSecrets(this.doc()) as Record<string, unknown>;
    // The answer always names the wolf: a wolf.yaml without `name:` is the wolf of its directory (the name wolfd serves it under).
    if (typeof config.name !== "string" || !config.name) config.name = wolfName ?? basename(this.wolfHome);
    return {
      etag: etagOf(text),
      config,
      editable: [...EDITABLE_KEYS],
      tierModels,
      ...(tierProviders ? { tierProviders } : {}),
      env: this.envNames(),
      restartNeeded: etagOf(text) !== this.bootEtag,
      restartable,
      restartAvailableInSeconds,
    };
  }

  /** The wolf's chosen color (a palette key) read live from wolf.yaml, or undefined (automatic). */
  color(): string | undefined {
    const c = this.doc().color;
    return typeof c === "string" && (THREAD_COLOR_KEYS as readonly string[]).includes(c) ? c : undefined;
  }

  envNames(): EnvVarView[] {
    return ENV_VARS.map((v) => ({ name: v.name, purpose: v.purpose, set: !!this.env[v.name], secret: isSecretValue(v.name, "") }));
  }

  /** One value: a listed env var, or a wolf.yaml dotted key. */
  reveal(source: "env" | "config", name: string): string | null {
    if (source === "env") {
      if (!ENV_VARS.some((v) => v.name === name)) throw new SettingsError("not_found", `unknown environment variable ${name}`);
      return this.env[name] ?? null;
    }
    let cur: unknown = this.doc();
    for (const part of name.split(".")) {
      if (!cur || typeof cur !== "object" || !Object.hasOwn(cur, part)) throw new SettingsError("not_found", `no setting ${name}`);
      cur = (cur as Record<string, unknown>)[part];
    }
    if (cur === null || typeof cur === "object") throw new SettingsError("not_found", `${name} is not a single value`);
    if (!isMaskedConfigKey(name, cur)) throw new SettingsError("not_found", `${name} is not masked; read it from the settings view`);
    return String(cur);
  }

  /** Apply `set` (dotted key -> value; null removes) after validating; atomic temp file + rename. */
  write(set: Record<string, unknown>, ifMatch: string | undefined): void {
    if (ifMatch === undefined) throw new SettingsError("invalid_request", "If-Match is required: send the etag from the settings you loaded");
    const text = this.text();
    if (ifMatch !== etagOf(text)) throw new SettingsError("conflict", "wolf.yaml changed since you loaded it");
    const doc = parseDocument(text);
    if (doc.errors.length > 0) throw new SettingsError("invalid_request", "wolf.yaml has a syntax error; fix it by hand");
    if (doc.contents === null || !isMap(doc.contents)) throw new SettingsError("invalid_request", "wolf.yaml is not a mapping");
    for (const [key, value] of Object.entries(set)) {
      if (!EDITABLE_KEYS.includes(key)) throw new SettingsError("invalid_request", `"${key}" is not an editable setting`);
      if (key === "color" && value !== null && !(typeof value === "string" && (THREAD_COLOR_KEYS as readonly string[]).includes(value))) {
        throw new SettingsError("invalid_request", `color must be one of ${THREAD_COLOR_KEYS.join(", ")} (or null for automatic)`);
      }
      const path = key.split(".");
      if (value === null) doc.deleteIn(path);
      else doc.setIn(path, value);
      // Drop a block this edit emptied, so the file stays free of `compaction: {}`.
      for (let n = path.length - 1; n > 0; n--) {
        const parent = doc.getIn(path.slice(0, n), true);
        if (isMap(parent) && parent.items.length === 0) doc.deleteIn(path.slice(0, n));
      }
    }
    const next = doc.toString();
    const parsed = WolfFileSchema.safeParse(parseYaml(next));
    if (!parsed.success) {
      throw new SettingsError("invalid_request", parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
    }
    backupFile(this.file, join(this.wolfHome, "agent", ".backups", "config"), "wolf", "yaml");
    atomicWrite(this.file, next);
  }
}
