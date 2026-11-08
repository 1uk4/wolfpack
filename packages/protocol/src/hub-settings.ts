/** GET /v1/settings (hubd): the hub's prompts, effective config (secrets masked) and build version. Read-only. */
import { z } from "zod";

export const HubPromptSchema = z.object({
  id: z.string(),
  group: z.string(),
  label: z.string(),
  /** The raw text the running build uses (templates keep their placeholders). */
  text: z.string(),
});
export type HubPrompt = z.infer<typeof HubPromptSchema>;

export const HubSettingsSchema = z.object({
  version: z.string(),
  prompts: z.array(HubPromptSchema),
  /** Effective config as loaded; every secret is replaced by `{ set: true }` (or `{ set: false }`), never the value. */
  config: z.record(z.string(), z.unknown()),
});
export type HubSettings = z.infer<typeof HubSettingsSchema>;
