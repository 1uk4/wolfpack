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
});
export type PromptView = z.infer<typeof PromptViewSchema>;

export const ListPromptsResponseSchema = z.object({ prompts: z.array(PromptViewSchema) });
export type ListPromptsResponse = z.infer<typeof ListPromptsResponseSchema>;

export const PutPromptBodySchema = z.object({ text: z.string() });
export type PutPromptBody = z.infer<typeof PutPromptBodySchema>;
