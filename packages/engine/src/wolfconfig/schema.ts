/**
 * wolf.yaml v2 — identity + capability + serve.
 *
 * File shape (flat identity, so every existing wolf.yaml keeps parsing):
 *
 *   id: ddkyhT              # optional, defaults to name
 *   name: 1uk4              # required
 *   domains: [personal]     # default []
 *   tools: [coding]         # capability: built-in tool registry names (default ["coding"]); does NOT limit tools from `extensions`
 *   tiers:                  # capability: per-tier overrides on the models file
 *     fast: { model: claude-sonnet-5-5, thinking: low }
 *   workspace: ~/Code/x     # capability: home-thread cwd (default: the wolf's dir)
 *   extensions: [memory]    # extensions loaded from <den>/extensions/<name>/index.js (default none)
 *   serve:                  # all optional
 *     socket: ~/.wolfpack/run/1uk4.sock   # default shown
 *     port: 7421                          # optional TCP (127.0.0.1); unset = none
 *   subagents:              # optional
 *     maxRunning: 3         # subagents running at once for this wolf (default 3); the rest queue
 *   sandbox: true           # redirect den / KB_OPS / WORK_ENDPOINT at a snapshot dev root (default <dir>/sandbox)
 *   sandbox: { root: ~/dev/sf-snap }      # ...or at an explicit dev root
 *   prompts:
 *     structuredOutput: |   # overrides the default decision/graph/checklist guidance; `false` removes the section
 *       ...
 *   memory:
 *     defaultDomain: personal  # domain for untagged observations (one of domains; default: first)
 *     live: true            # durable memory may write the LIVE roots (nothing sets this until cutover)
 *     consolidation:        # all optional; defaults shown (pi's thresholds)
 *       threshold: 20000    # pool tokens that trigger consolidation
 *       poolTarget: 10000   # pool tokens left in the pool after one
 *       trigger: hybrid     # threshold | timer | hybrid | manual
 *       interval: 4h        # timer / hybrid cadence
 *
 * There is NO `runtime` field: durable is the engine. Unknown keys (runtime,
 * profile, role, transport, models, …) are accepted, ignored, and
 * reported in `warnings`. `den` is derived: <dir>/den.
 */
import { z } from "zod";

/** An editable prompt section: text replaces the default, `false` (or empty text) removes it. */
export type PromptSection = string | false;

export const DEFAULT_TOOLS = ["coding"] as const;

/** Pi's consolidation defaults (extensions/wolfpack-memory/index.ts), plus the existing trigger and interval. */
export const DEFAULT_CONSOLIDATION = { threshold: 20000, poolTarget: 10000, trigger: "hybrid", interval: "4h" } as const;

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
  extensions: z.array(z.string().min(1)).default([]),
  serve: z
    .object({
      socket: z.string().min(1).optional(),
      port: z.number().int().min(1).max(65535).optional(),
    })
    .passthrough()
    .default({}),
  subagents: z.object({ maxRunning: z.number().int().min(1).optional() }).passthrough().optional(),
  sandbox: z.union([z.boolean(), z.object({ root: z.string().min(1) }).passthrough()]).optional(),
  prompts: z.object({ structuredOutput: z.union([z.string(), z.literal(false)]).optional() }).passthrough().optional(),
  memory: z
    .object({
      live: z.boolean().optional(),
      librarian: z.boolean().optional(),
      defaultDomain: z.string().min(1).optional(),
      sweepInterval: z.string().regex(/^\d+(s|m|h|d)$/, 'expected a duration like "30s", "1m", "1h"').optional(),
      consolidation: z
        .object({
          threshold: z.number().int().positive().optional(),
          poolTarget: z.number().int().nonnegative().optional(),
          trigger: z.enum(["threshold", "timer", "hybrid", "manual"]).optional(),
          interval: z.string().regex(/^\d+(s|m|h|d)$/, 'expected a duration like "30m", "4h", "1d"').optional(),
        })
        .passthrough()
        .default({}),
    })
    .passthrough()
    .default({}),
});

/** Keys the v2 file schema knows; anything else is ignored with a warning. */
export const KNOWN_TOP_LEVEL_KEYS: readonly string[] = [
  "id",
  "name",
  "domains",
  "tools",
  "tiers",
  "workspace",
  "extensions",
  "serve",
  "subagents",
  "sandbox",
  "prompts",
  "memory",
  "workspaces",
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
  /** Subagent limits (wolf.yaml `subagents:`); unset fields take wolfd's defaults. */
  subagents?: { maxRunning?: number };
  /** Present when `sandbox` is on: the dev root everything outward is redirected into. Absolute path. */
  sandbox?: { root: string };
  /** Editable prompt sections; unset = the harness default. */
  prompts: {
    /** Replaces the default structured-output guidance; `false` removes the section. */
    structuredOutput?: PromptSection;
  };
  memory: {
    /** Durable memory may write the live roots. Off unless explicitly set (fail closed). */
    live: boolean;
    /** Librarian mode (mutates KB_BASE); in a sandbox only on a KB copy (`<root>/kb-base`), otherwise refused. */
    librarian: boolean;
    /** Librarian sweep interval (e.g. "1m"); default 1m. */
    sweepInterval?: string;
    /** Domain stamped on observations the observer leaves untagged. One of `identity.domains`; default: the first. */
    defaultDomain?: string;
    /** Pool thresholds and trigger, defaults applied. */
    consolidation: {
      /** Pool tokens at which consolidation runs. */
      threshold: number;
      /** Pool tokens left behind by a consolidation (the newest observations). */
      poolTarget: number;
      trigger: "threshold" | "timer" | "hybrid" | "manual";
      interval: string;
    };
  };
  /**
   * Extensions to load, by wolf.yaml short name (`memory`, `ask`, ...), in order. The loader that resolves them is
   * the harness's; the same list drives createWolfHarness and wolfd.
   */
  extensions: string[];
  /** The raw wolf.yaml block of each listed extension that has one (`memory:` etc.), as the loader hands it over. */
  extensionConfig: Record<string, Record<string, unknown>>;
  /** Derived: <dir>/den. */
  den: string;
  /** Directory containing wolf.yaml. */
  dir: string;
  /** Absolute path of wolf.yaml. */
  file: string;
}
