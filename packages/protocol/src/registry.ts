/** Hub registry (hubd): hosts, wolves, domains and subscriptions. Reads: any actor. Writes: operator only (403 `forbidden`). */
import { z } from "zod";

const Name = z.string().min(1).max(64);
const TierSchema = z.object({ model: z.string().min(1).optional(), thinking: z.string().min(1).optional() }).passthrough();

export const RegistryHostSchema = z.object({
  name: Name,
  address: z.string().optional(),
  notes: z.string().optional(),
});
export type RegistryHost = z.infer<typeof RegistryHostSchema>;

export const RegistryWolfStatusSchema = z.enum(["active", "retired"]);

export const RegistryWolfSchema = z.object({
  name: Name,
  host: z.string().optional(),
  domains: z.array(z.string().min(1)).default([]),
  tools: z.array(z.string().min(1)).default([]),
  workspace: z.string().optional(),
  tiers: z.object({ main: TierSchema.optional(), smart: TierSchema.optional(), fast: TierSchema.optional() }).passthrough().optional(),
  status: RegistryWolfStatusSchema.default("active"),
});
export type RegistryWolf = z.infer<typeof RegistryWolfSchema>;

export const RegistryDomainSchema = z.object({
  name: Name,
  label: z.string().optional(),
  description: z.string().optional(),
  color: z.string().optional(),
  /** YYYY-MM-DD */
  created: z.string().optional(),
});
export type RegistryDomain = z.infer<typeof RegistryDomainSchema>;

/** A subscription id is `<wolf>:<domain>`. */
export const RegistrySubscriptionSchema = z.object({ wolf: Name, domain: Name });
export type RegistrySubscription = z.infer<typeof RegistrySubscriptionSchema>;

export const RegistryFileSchema = z.object({
  version: z.literal(1),
  hosts: z.array(RegistryHostSchema).default([]),
  wolves: z.array(RegistryWolfSchema).default([]),
  domains: z.array(RegistryDomainSchema).default([]),
  subscriptions: z.array(RegistrySubscriptionSchema).default([]),
});
export type RegistryFile = z.infer<typeof RegistryFileSchema>;

// Update bodies: every field but the name is optional; the name comes from the path.
export const UpdateRegistryHostRequestSchema = RegistryHostSchema.omit({ name: true }).strict();
export const UpdateRegistryWolfRequestSchema = RegistryWolfSchema.omit({ name: true, status: true }).partial().strict();
export const UpdateRegistryDomainRequestSchema = RegistryDomainSchema.omit({ name: true }).strict();

export const RegistryHostsResponseSchema = z.object({ hosts: z.array(RegistryHostSchema) });
export const RegistryWolvesResponseSchema = z.object({ wolves: z.array(RegistryWolfSchema) });
export const RegistryDomainsResponseSchema = z.object({ domains: z.array(RegistryDomainSchema) });
export const RegistrySubscriptionsResponseSchema = z.object({ subscriptions: z.array(RegistrySubscriptionSchema) });
export const RegistryHostResponseSchema = z.object({ host: RegistryHostSchema });
export const RegistryWolfResponseSchema = z.object({ wolf: RegistryWolfSchema });
export const RegistryDomainResponseSchema = z.object({ domain: RegistryDomainSchema });
export const RegistrySubscriptionResponseSchema = z.object({ subscription: RegistrySubscriptionSchema });
/** Retire answers with the entry and the work items whose claims were released. */
export const RetireWolfResponseSchema = z.object({ wolf: RegistryWolfSchema, released: z.array(z.string()) });
export const RegistryDeleteResponseSchema = z.object({ deleted: z.string() });
