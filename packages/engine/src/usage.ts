/**
 * Usage tracking — accumulates token usage and cost across pipeline runs.
 *
 * Every adapter call returns a UsageRecord. The tracker collects them,
 * provides summaries, and can be serialized for persistence.
 */
import type { UsageRecord } from "./adapter.js";

export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  callCount: number;
  byStep: Record<string, { input: number; output: number; calls: number }>;
  byModel: Record<string, { input: number; output: number; calls: number }>;
}

export class UsageTracker {
  private records: UsageRecord[] = [];

  record(usage: UsageRecord): void {
    this.records.push(usage);
  }

  summarize(): UsageSummary {
    const byStep: UsageSummary["byStep"] = {};
    const byModel: UsageSummary["byModel"] = {};
    let totalInput = 0;
    let totalOutput = 0;

    for (const r of this.records) {
      totalInput += r.inputTokens;
      totalOutput += r.outputTokens;

      // By step
      if (!byStep[r.step]) byStep[r.step] = { input: 0, output: 0, calls: 0 };
      byStep[r.step].input += r.inputTokens;
      byStep[r.step].output += r.outputTokens;
      byStep[r.step].calls += 1;

      // By model
      if (!byModel[r.model])
        byModel[r.model] = { input: 0, output: 0, calls: 0 };
      byModel[r.model].input += r.inputTokens;
      byModel[r.model].output += r.outputTokens;
      byModel[r.model].calls += 1;
    }

    return {
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalTokens: totalInput + totalOutput,
      callCount: this.records.length,
      byStep,
      byModel,
    };
  }

  /** All raw records for persistence or debugging */
  getRecords(): readonly UsageRecord[] {
    return this.records;
  }

  /** Reset the tracker */
  reset(): void {
    this.records = [];
  }
}
