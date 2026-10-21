/**
 * Cost for a usage event: keep what the source reported, else price it from
 * pi-ai's model catalog — the API-equivalent ("notional") for subscription
 * calls, the metered price ("computed") for the rest.
 */
import { calculateCost, type Usage } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import type { UsageEvent } from "@wolfpack/engine";

type CatalogModel = Parameters<typeof calculateCost>[0];

const catalogs = new Map<string, Map<string, CatalogModel>>();

/** The catalog model for a provider + model id, if pi-ai knows it. */
export function catalogModel(provider: string, model: string): CatalogModel | undefined {
  let byId = catalogs.get(provider);
  if (!byId) {
    byId = new Map();
    try {
      for (const m of getModels(provider as Parameters<typeof getModels>[0])) byId.set(m.id, m);
    } catch {
      /* not a catalog provider */
    }
    catalogs.set(provider, byId);
  }
  return byId.get(model) ?? byId.get(model.slice(model.lastIndexOf("/") + 1));
}

/** An event before pricing. */
export type UnpricedEvent = Omit<UsageEvent, "costUsd" | "costSource">;

/**
 * Price one call. `reported` is the source's own cost total (used when > 0);
 * `cacheWrite1h` is Anthropic's 1h-retention share of cacheWrite, when known.
 */
export function priceEvent(e: UnpricedEvent, reported?: number, cacheWrite1h?: number): UsageEvent {
  if (reported !== undefined && reported > 0) return { ...e, costUsd: reported, costSource: "reported" };
  const subscription = e.billing === "subscription";
  const model = catalogModel(subscription ? "anthropic" : e.provider, e.model);
  if (!model) return { ...e, costSource: "unknown" };
  const usage: Usage = {
    input: e.input,
    output: e.output,
    cacheRead: e.cacheRead,
    cacheWrite: e.cacheWrite,
    cacheWrite1h,
    totalTokens: e.input + e.output + e.cacheRead + e.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const cost = calculateCost(model, usage);
  return { ...e, costUsd: cost.total, costSource: subscription ? "notional" : "computed" };
}

/** Fill in a cost an engine event arrived without; keep one it already has. */
export function priceLoggedEvent(e: UsageEvent): UsageEvent {
  if (e.costUsd !== undefined && e.costSource !== "unknown") return e;
  const { costUsd, costSource: _, ...rest } = e;
  return priceEvent(rest, costUsd);
}
