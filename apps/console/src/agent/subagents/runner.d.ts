import type { PiEngine } from "../models.ts";
import type { SearchProvider } from "../../core/search.ts";
import { type DemoToolInput, type PdfToolInput, type ResearchToolInput, type SteerMessage, type VisualToolInput } from "../../core/contracts.ts";
import type { ModelRole } from "../../../config.ts";
import { type ModelSlotName, type ProviderKeyMissing } from "../../core/settings.ts";
import type { ChatStore, JobStore } from "../../core/ports.ts";
/**
 * The background job runner (contracts.ts "THE ASYNC PROTOCOL" §2–3), created
 * via createJobRunner({ chatStore, jobStore, deliver }) — the composition root
 * (chat-handler) injects the storage ports and the WAKE SEAM (the server-side
 * steer delivery, src/server/jobs.ts); this module never imports an adapter.
 *
 *   runJob(jobId) — runs the kind's sub-agent loop in the background
 *     (the job tools' execute fires this via the spawn seam, fire-and-forget),
 *     updating the job's activity line on every iteration. On completion the
 *     runner builds the STEER MESSAGE (buildSubagentSteer) and hands it to
 *     `deliver`; the wake pipeline fires the server-side teacher turn and
 *     flips the job to done/error when the lesson has actually resumed.
 *
 *   On failure the result is the failure shape (empty html/svg + "FAILED: …"
 *   notes; research: failure brief) — and it STILL steers, because the
 *   teacher must learn the outcome. If delivery itself fails, the job is
 *     marked error (the learner's activity card shows it).
 */
/**
 * Test seam: the spawn wiring has no injection point at the tool layer, so
 * tests swap in a scripted pi engine here to keep job tests off the network.
 * Undefined in production. (The jobs spawn through the module-level KIND
 * runners, which read these at call time.)
 */
export declare const researchModelOverride: {
    current?: PiEngine;
};
export declare const demoModelOverride: {
    current?: PiEngine;
};
export declare const visualModelOverride: {
    current?: PiEngine;
};
export declare const pdfModelOverride: {
    current?: PiEngine;
};
/** The dispatch-time tool input (from src/agent/tools/jobs.ts schemas). */
type JobToolInput = ResearchToolInput | DemoToolInput | VisualToolInput | PdfToolInput;
export interface JobRunnerDeps {
    chatStore: ChatStore;
    jobStore: JobStore;
    /**
     * Hand a finished job's steer to the wake pipeline — resolves when the
     * steer is delivered (the wake turn completed and the job status
     * flipped); rejects when delivery fails unrecoverably.
     */
    deliver: (steer: SteerMessage) => Promise<void>;
    /** Settings-resolved engine per role (model slots wave, 2026-09-20):
     *  the role-override → slot chain, read FRESH per job (the server
     *  wiring passes effectiveSettings-based resolution). Test overrides
     *  (below) still win. BYOK (owner, 2026-09-22): the chain may end
     *  EMPTY → undefined; runJob then refuses the spawn honestly instead
     *  of guessing a model. */
    engineFor?: (role: ModelRole) => PiEngine | undefined;
    /** The search seam (search port wave, 2026-09-20): resolves the LIVE
     *  provider fresh per job — server/search.ts composition injected by
     *  the wiring; null = honestly unavailable (the researcher's web_search
     *  reports it). Absent seam (tests) reads the same. The dispatch-level
     *  drop (jobTools' searchAvailable) uses the same signal — jobs already
     *  in flight when a key disappears still fail honestly, never crash. */
    searchProvider?: () => SearchProvider | null;
    /** Key-presence gate (provider-key interlude, 2026-09-25): given the
     *  resolved engine's provider + the kind's slot tier, return the
     *  refusal envelope when the provider's key is missing (null = run).
     *  Injected because the agent layer may not read the key store; absent
     *  in tests that inject engines directly (test engines never owe a key). */
    providerKeyMissing?: (provider: string, tier: ModelSlotName) => ProviderKeyMissing | null;
}
export interface JobRunner {
    /** Run one job's sub-agent loop to completion (background; never throws).
     *  The tool input rides along from dispatch (the spawn fires mid-stream,
     *  before the tool part is persisted — only crash-recovery re-spawns
     *  resolve the input from the transcript). */
    runJob(jobId: string, input?: JobToolInput): Promise<void>;
}
export declare function createJobRunner(deps: JobRunnerDeps): JobRunner;
export {};
//# sourceMappingURL=runner.d.ts.map