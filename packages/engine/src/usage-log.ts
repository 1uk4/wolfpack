/**
 * Usage events — one record per model call, from any source, in one
 * provider-agnostic shape. Engine calls append them to the wolf's den
 * (usage/<YYYY-MM>.jsonl); `wolfpack usage` also derives them from pi session
 * files and pi-durable stores, which already record per-reply usage.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Where the call was observed. */
export type UsageSource = "engine" | "pi" | "durable";

/**
 * How the call is paid for: `api` (metered key), `subscription` (Max plan —
 * cost is notional), or the provider's id for anything else (e.g. `openrouter`).
 */
export type UsageBilling = "api" | "subscription" | (string & {});

/** Where `costUsd` came from. */
export type CostSource = "reported" | "computed" | "notional" | "unknown";

export interface UsageEvent {
  /** ISO timestamp of the call. */
  ts: string;
  wolf: string;
  source: UsageSource;
  /** Session / conversation the call belongs to, when known. */
  session?: string;
  /** What made the call: `main`, `subagent`, or `step:<engine step>`. */
  use: string;
  /** Provider id as recorded (`anthropic`, `claude-bridge`, `claude-agent-sdk`, `openrouter`, …). */
  provider: string;
  billing: UsageBilling;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** USD for the call: real spend for api, the API-equivalent for subscription. */
  costUsd?: number;
  costSource: CostSource;
}

/** Billing for a provider id. Unknown providers bill as themselves. */
export function billingFor(provider: string): UsageBilling {
  switch (provider) {
    case "anthropic":
      return "api";
    case "claude-bridge":
    case "claude-agent-sdk":
      return "subscription";
    default:
      return provider;
  }
}

/** The den's usage log for a timestamp: <den>/usage/<YYYY-MM>.jsonl. */
export function usageLogPath(den: string, ts: string = new Date().toISOString()): string {
  return path.join(den, "usage", `${ts.slice(0, 7)}.jsonl`);
}

/** Append one event. Never throws — usage logging must not fail a model call. */
export function appendUsageEvent(den: string, event: UsageEvent): void {
  try {
    const file = usageLogPath(den, event.ts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + "\n");
  } catch {
    /* best effort */
  }
}

/** Read every event in a den's usage logs (skips unparsable lines). */
export function readUsageLog(den: string): UsageEvent[] {
  const dir = path.join(den, "usage");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const out: UsageEvent[] = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as UsageEvent);
      } catch {
        /* skip a torn line */
      }
    }
  }
  return out;
}
