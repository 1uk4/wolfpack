/**
 * wolf.yaml v2 — identity + capability + serve.
 *
 * File shape (flat identity, so every existing wolf.yaml keeps parsing):
 *
 *   id: ddkyhT              # optional, defaults to name
 *   name: 1uk4              # required
 *   domains: [personal]     # default []
 *   tools: [coding]         # capability: tool registry names (default ["coding"])
 *   tiers:                  # capability: per-tier overrides on the models file
 *     fast: { model: claude-sonnet-5-5, thinking: low }
 *   workspace: ~/Code/x     # capability: home-thread cwd (default: the wolf's dir)
 *   serve:                  # all optional
 *     socket: ~/.wolfpack/run/1uk4.sock   # default shown
 *     port: 7421                          # optional TCP (127.0.0.1); unset = none
 *   sandbox: true           # redirect den / KB_OPS / WORK_ENDPOINT at a snapshot dev root (default <dir>/sandbox)
 *   sandbox: { root: ~/dev/sf-snap }      # ...or at an explicit dev root
 *   memory:
 *     live: true            # durable memory may write the LIVE roots (nothing sets this until cutover)
 *
 * There is NO `runtime` field: durable is the engine. Unknown keys (runtime,
 * profile, role, extensions, transport, models, …) are accepted, ignored, and
 * reported in `warnings`. `den` is derived: <dir>/den.
 */
import { z } from "zod";

export const DEFAULT_TOOLS = ["coding"] as const;

const TierOverride = z
  .object({ model: z.string().min(1).optional(), thinking: z.string().min(1).optional() })
  .passthrough();

export const WolfFileSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  domains: z.array(z.string().min(1)).default([]),
  tools: z.array(z.string().min(1)).default([...DEFAULT_TOOLS]),
  tiers: z
    .object({ main: TierOverride.optional(), smart: TierOverride.optional(), fast: TierOverride.optional() })
    .passthrough()
    .optional(),
  workspace: z.string().min(1).optional(),
  serve: z
    .object({
      socket: z.string().min(1).optional(),
      port: z.number().int().min(1).max(65535).optional(),
    })
    .passthrough()
    .default({}),
  sandbox: z.union([z.boolean(), z.object({ root: z.string().min(1) }).passthrough()]).optional(),
  memory: z.object({ live: z.boolean().optional() }).passthrough().default({}),
});

/** Keys the v2 file schema knows; anything else is ignored with a warning. */
export const KNOWN_TOP_LEVEL_KEYS: readonly string[] = [
  "id",
  "name",
  "domains",
  "tools",
  "tiers",
  "workspace",
  "serve",
  "sandbox",
  "memory",
];

export interface TierOverrideConfig {
  model?: string;
  thinking?: string;
}

/** Normalized, defaults-applied wolf config. */
export interface WolfConfig {
  identity: { id: string; name: string; domains: string[] };
  capability: {
    tools: string[];
    tiers?: Partial<Record<"main" | "smart" | "fast", TierOverrideConfig>>;
    /** Absolute path. Default: the directory holding wolf.yaml. */
    workspace: string;
  };
  serve: {
    /** Absolute path. Default: ~/.wolfpack/run/<name>.sock */
    socket: string;
    /** Optional 127.0.0.1 TCP port; undefined = not listening on TCP. */
    port?: number;
  };
  /** Present when `sandbox` is on: the dev root everything outward is redirected into. Absolute path. */
  sandbox?: { root: string };
  memory: {
    /** Durable memory may write the live roots. Off unless explicitly set (fail closed). */
    live: boolean;
  };
  /** Derived: <dir>/den. */
  den: string;
  /** Directory containing wolf.yaml. */
  dir: string;
  /** Absolute path of wolf.yaml. */
  file: string;
}
