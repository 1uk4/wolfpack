import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WolfConfig } from "@wolfpack/engine";

export type WolfTransport = "api" | "subscription";

/**
 * A wolf's transport: `"transport"` in the models.json next to the wolf's wolf.yaml wins; WOLF_TRANSPORT in the environment is only a
 * fallback for a wolf with no models.json transport (a global value must not turn a subscription wolf into an API wolf).
 * FALLBACK: anything but an explicit "api" (missing file, unreadable, unparsable, no field, unknown value) is "subscription". A metered
 * key is never sent to a wolf on a guess; the cost of a wrong guess the other way is only a wolf that keeps its own credentials.
 */
export function wolfTransport(config: Pick<WolfConfig, "file">, env: NodeJS.ProcessEnv = process.env): WolfTransport {
  let t: string | undefined;
  try {
    const j = JSON.parse(readFileSync(join(dirname(config.file), "models.json"), "utf8")) as { transport?: unknown };
    t = typeof j.transport === "string" && j.transport.trim() ? j.transport.trim() : undefined;
  } catch {
    t = undefined;
  }
  t ??= env.WOLF_TRANSPORT?.trim() || undefined;
  return t === "api" ? "api" : "subscription";
}

/** Names of the wolves that run on an API key: the only ones that receive or are restarted for the Anthropic key. */
export function apiWolfNames(configs: Pick<WolfConfig, "file" | "identity">[], env: NodeJS.ProcessEnv = process.env): string[] {
  return configs.filter((c) => wolfTransport(c, env) === "api").map((c) => c.identity.name);
}
