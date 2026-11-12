/**
 * Command channel frames (additive over link protocol 1, no version bump). The hub asks a connected machine (workerd) to do one thing
 * and gets one result back:
 *   hub -> worker  cmd         {id: "c-<uuid>", kind, args, sealed?}   `sealed` is opaque to the channel (key bytes, sealed by the Keys task).
 *   worker -> hub  cmd.result  {id, ok, code?, message?, data?}
 * A worker advertises the kinds it can run in `hello.commands`; an older worker sends none and the hub answers `not_sent_unsupported`.
 * Result codes `not_sent_offline`, `not_sent_unsupported` and `timeout` are produced by the hub only (`timeout` = the outcome is unknown;
 * never retry automatically). The rest come from the worker.
 */
import { z } from "zod";

export const COMMAND_KINDS = ["key.set", "key.remove", "wolves.restart", "workerd.restart", "logs.fetch"] as const;
export const CommandKindSchema = z.enum(COMMAND_KINDS);
export type CommandKind = z.infer<typeof CommandKindSchema>;

/** Hub-side timeouts per kind (ms). workerd.restart waits only for the ack that is sent before the process exits. */
export const COMMAND_TIMEOUT_MS: Record<CommandKind, number> = {
  "key.set": 20_000,
  "key.remove": 20_000,
  "wolves.restart": 15_000,
  "logs.fetch": 15_000,
  "workerd.restart": 5_000,
};

export const COMMAND_LOGS_DEFAULT_LINES = 200;
export const COMMAND_LOGS_MAX_LINES = 1000;
export const COMMAND_LOGS_MAX_BYTES = 256 * 1024;
/** Exit status workerd uses to ask its supervisor for a restart (systemd Restart=on-failure). */
export const WORKERD_RESTART_EXIT_CODE = 75;

export const CommandIdSchema = z.string().regex(/^c-[A-Za-z0-9-]{1,64}$/);

export const CommandArgsSchemas = {
  "wolves.restart": z.object({ wolf: z.string().min(1).max(64).optional() }).strict(),
  "workerd.restart": z.object({}).strict(),
  "logs.fetch": z.object({ service: z.string().regex(/^[a-z0-9][a-z0-9._@-]*$/).max(64), lines: z.number().int().min(1).max(COMMAND_LOGS_MAX_LINES) }).strict(),
  "key.set": z.object({ slot: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/) }).strict(),
  "key.remove": z.object({ slot: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/) }).strict(),
} as const;

const AnyArgs = z.union([CommandArgsSchemas["logs.fetch"], CommandArgsSchemas["key.set"], CommandArgsSchemas["wolves.restart"], CommandArgsSchemas["workerd.restart"]]);

const CmdBase = z.object({
    kind: CommandKindSchema,
    args: AnyArgs.default({}),
    /** Opaque to the channel; for key.set only. */
    sealed: z.string().max(64 * 1024).optional(),
  });
const argsMatchKind = (f: { kind: CommandKind; args: unknown }) => CommandArgsSchemas[f.kind].safeParse(f.args).success;
export const LinkCmdSchema = CmdBase.extend({ t: z.literal("cmd"), id: CommandIdSchema }).refine(argsMatchKind, { message: "args do not match kind" });
/** Console -> hub body of POST /v1/machines/:hostId/commands. The hub assigns the command id. */
export const CommandRequestSchema = CmdBase.extend({ id: CommandIdSchema.optional() }).refine(argsMatchKind, { message: "args do not match kind" });

export const CommandResultCodeSchema = z.enum([
  "not_sent_offline",
  "not_sent_unsupported",
  "timeout",
  "restart_failed",
  "internal",
  "unknown_service",
  "not_found",
  "rejected_key",
  "bad_seal",
  "replay",
  "store_failed",
  "check_unreachable",
]);
export type CommandResultCode = z.infer<typeof CommandResultCodeSchema>;

export const LinkCmdResultSchema = z.object({
  t: z.literal("cmd.result"),
  id: CommandIdSchema,
  ok: z.boolean(),
  code: CommandResultCodeSchema.optional(),
  message: z.string().max(2000).optional(),
  data: z.unknown().optional(),
});

/** The hub's answer: 200 when the machine ran it (ok true or false), 409 for not_sent_*, 504 for timeout. Never carries the request body. */
export const CommandResponseSchema = z.object({
  id: CommandIdSchema,
  ok: z.boolean(),
  code: CommandResultCodeSchema.optional(),
  message: z.string().max(2000).optional(),
  data: z.unknown().optional(),
});
export type CommandResponse = z.infer<typeof CommandResponseSchema>;

export interface RestartedWolf {
  wolf: string;
  wasActive: boolean;
  midReply: boolean;
}
export interface RestartData {
  restarted: RestartedWolf[];
}
export interface LogsData {
  lines: string[];
  truncated: boolean;
}
