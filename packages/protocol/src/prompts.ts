/** The per-wolf prompt registry over /v1/wolves/:name/prompts: effective text, where it came from, and a version tag to write against. */
import { z } from "zod";

export const PromptViewSchema = z.object({
  id: z.string(),
  group: z.string(),
  label: z.string(),
  /** A wolf may override it (PUT). Others are shown read-only. */
  editable: z.boolean(),
  /** The effective text: the wolf's override when it has one, else the repo default. */
  text: z.string(),
  source: z.enum(["default", "override"]),
  /** Hash of the effective text: send as If-Match on PUT/DELETE; a different current etag is 409 `conflict`. */
  etag: z.string(),
  /** Which part of the system the prompt belongs to; absent on the editable work-creation prompts. */
  kind: z.enum(["editable", "system-block", "tool", "pipeline", "compaction"]).optional(),
  /** Where the text lives (repo path, or the wolf-home file for a block read from there). */
  file: z.string().optional(),
  /** The process or agent that uses it (main wolf, subagent, memory pipeline, crawl, console, ...). */
  user: z.string().optional(),
  /** per-wolf: this wolf's own copy; global: the same for every wolf; hub: runs on the hub. */
  scope: z.enum(["wolf", "global", "hub"]).optional(),
  /** Pipeline prompts: the shape the reply is parsed against, as readable JSON-schema-like text. Read-only. */
  contract: z.string().optional(),
  /** The {{name}} placeholders the text declares. */
  placeholders: z.array(z.string()).optional(),
  /** Editable prompts: where the override lives (`prompts`, `agents` for helper profiles, `standards`) and the file name in it. */
  store: z.enum(["prompts", "agents", "standards", "identity"]).optional(),
  name: z.string().optional(),
  /** Editable prompts: when an edit takes effect (wolf restart, or the next subagent spawn). */
  applies: z.string().optional(),
  /** Profiles and standards: a project `.pi` file in the wolf's workspace outranks the wolf's edit. */
  projectOverride: z.boolean().optional(),
  /** Identity only: wolf.yaml `identity:` points at this file, so the running wolf ignores agent/AGENTS.md (the file this entry edits). */
  inlineIdentity: z.string().optional(),
  /** Identity only: a pristine copy from before the first console edit exists, so Restore original works. */
  hasOriginal: z.boolean().optional(),
});
export type PromptView = z.infer<typeof PromptViewSchema>;

export const ListPromptsResponseSchema = z.object({ prompts: z.array(PromptViewSchema) });
export type ListPromptsResponse = z.infer<typeof ListPromptsResponseSchema>;

export const PutPromptBodySchema = z.object({ text: z.string() });
export type PutPromptBody = z.infer<typeof PutPromptBodySchema>;
