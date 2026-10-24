/**
 * provider-events — the raw-wire recorder (owner, 2026-10-04).
 *
 * pi-ai 1.0's onProviderStreamEvent observer fires for each PARSED
 * provider stream event BEFORE pi normalizes it — the exact layer where
 * our provider-quirk incident class lives and where nothing else in the
 * app can see: GLM-flash truncating tool-call arguments mid-JSON
 * (2026-09-25), DeepSeek resetting tool-call ids every response
 * (2026-10-04, the Lacan session). This module turns that observer into
 * an inspectable artifact.
 *
 * Gating (owner choice, 2026-10-04): env var only —
 *   LH_PROVIDER_EVENTS=1 npm run dev
 * Default off: raw events carry full prompts (privacy) and unbounded
 * volume (disk). No app surface; a debugging feature, not a feature.
 *
 * Artifact: one JSONL file per chat at
 *   data/debug/provider-events/<chatId>.jsonl
 * (data/ is disposable scratch — no retention system). Each line:
 *   {"t":<epoch ms>,"ctx":"teacher|prober|job:<role>","provider":…,"model":…,"event":<raw>}
 * plus {"note":…} run markers. A per-file byte cap (CAPPED at ~20 MB)
 * writes one truncation marker and stops — a runaway turn must not fill
 * the disk. Event payloads are adapter-owned; a non-serializable event
 * degrades to a type note, never throws (an observer exception must not
 * kill a stream).
 */
/** Test seam (the toolTimeoutMs idiom): shrink the cap to exercise it. */
export declare const providerEventsCap: {
    current: number;
};
/** Test seam (the toolTimeoutMs idiom): redirect the output directory. */
export declare const providerEventsDir: {
    current: string;
};
/** The model shape the observer receives (structural — pi passes Model). */
export interface ProviderEventModel {
    provider?: string;
    id?: string;
}
export type ProviderEventObserver = (data: unknown, model: ProviderEventModel) => void;
/** True when recording is on (read per call — toggling needs no restart
 *  beyond the next turn's agent construction). */
export declare function providerEventsEnabled(): boolean;
/**
 * The observer for one agent run, or undefined when disabled. Pass the
 * result as the Agent's onProviderStreamEvent (both construction sites —
 * teacher-agent's baseAgentOptions and pi-run's runSubagent — build it
 * from a chatId in hand).
 */
export declare function providerEventObserver(chatId: string, context: string): ProviderEventObserver | undefined;
/** A run marker (start/end/abort notes) so events correlate with the
 *  persisted record; no-op when disabled. */
export declare function providerEventNote(chatId: string, context: string, text: string): void;
//# sourceMappingURL=provider-events.d.ts.map