import type { Usage } from "@earendil-works/pi-ai";
import type { ModelRole } from "../../../config.ts";
import { type ModelSlotName, type ProviderKeyMissing } from "../../core/settings.ts";
import type { PiEngine } from "../models.ts";
import type { CallUsage, ChatRecord, ExtractionStageUsage } from "../../core/contracts.ts";
import { type DerivedGraph, type EmissionStats, type GraphDeps } from "../../core/graph.ts";
/**
 * The extraction pipeline (vision §1 construction, 2026-09-02 redesign;
 * relinked 2026-09-27) — the sole graph writer. Three stages, one
 * orchestrator (the spine stage came and went, 2026-09-30: serialized
 * digest-aware extraction replaced it — the owner's live test showed
 * the post-hoc assembly pass added complexity without perceptible
 * gain; the extractor itself is the assembler now):
 *
 *   extractor (LLM)  the ONE stage that sees the raw source (a session
 *                    rendered as the teacher's prose — each passage
 *                    labeled with its ACTUAL message id, "TEACHER [id]",
 *                    owner 2026-10-13 — or a notes file verbatim, walked
 *                    in stretches) → submits NEW core ideas + reasoning
 *                    chains (owner redesign, 2026-09-30); a session
 *                    submit additionally carries each proposition's
 *                    messageId — the anchor the merger stamps into the
 *                    node's message-granular provenance (2026-10-13).
 *                    DIGEST-AWARE (2026-09-30 evening):
 *                    when the source already yielded material, the
 *                    prompt carries THE GRAPH SO FAR (that source's
 *                    propositions + chains, ids verbatim) and the
 *                    extractor builds on it — referencing existing ids
 *                    instead of restating, leaning on established
 *                    conclusions as premises. Stretches of one source
 *                    run SERIALLY (each extract reads every earlier
 *                    merge); tree-blind, FULLY TRUSTED — nothing
 *                    downstream re-checks it.
 *   auditor (LLM)    never sees the source. Its job is IDENTITY: for each
 *                    NEW proposition, linkTo an existing graph node or
 *                    create — decided by EXPLORING the graph through
 *                    tools (find / list_sessions / list_propositions),
 *                    not by an injected graph dump (context bloat,
 *                    owner 2026-09-27). Links are its ONLY deliverable
 *                    — it never mints edges (owner 2026-09-28: the
 *                    graph connects across sources solely through
 *                    identified equivalences). Input is PROPOSITIONS
 *                    only — never chains (owner 2026-09-30).
 *   merger (core)    mergeFindings() → deterministic ledger appends +
 *                    chain simplification (2026-09-30 evening: the
 *                    ancestry-cover / prefer-fewest-premises pass that
 *                    strips redundant derivations — core/graph.ts)
 *
 * The events ledger is GONE (2026-09-27): quiz outcomes and understanding
 * observations are no longer formalized in the graph — the graph is purely
 * extracted reasoning chains (nodes + edges).
 *
 * The extractor is a single-tool-call worker (one TypeBox-validated submit
 * call — a pi agent purely so the model can retry a schema-invalid call).
 * The auditor is a small AGENTIC loop: exploration tools plus one submit.
 *
 * Created via createExtractionPipeline(deps) — the composition root
 * (chat-handler) injects the storage ports + models; this module never
 * imports an adapter. runExtraction is single-flight per chat: a second
 * trigger while one run is in flight is a no-op (the next trigger picks up
 * whatever the in-flight run missed). On failure nothing is checkpointed —
 * the next trigger re-runs the whole thing.
 *
 * The FORMAT-AGNOSTIC FRONT DOOR (2026-09-13): importNotes() runs the SAME
 * three stages over raw personal notes (arbitrary format — no chat, no
 * session, no message ids). A notes-mode extractor prompt replaces the
 * session one; the auditor and merger are shared (identity + deterministic
 * appends don't care where text came from). Provenance is the file itself:
 * source ids ("src_" + path hash) play the chatId role in mappings and
 * checkpoints, and the source record (graphStore sources seam) carries
 * the file path + the run's usage.
 *
 * Observability (§5 baseline): every stage logs one line per step, its
 * start, and its duration; the pipeline logs a failure line before
 * rethrowing, so the server log reads start → stage timings → merged
 * stats (or failed) for every run.
 */
/**
 * The extraction view: the session as TEACHER PROSE ONLY (owner ruling,
 * 2026-09-28 — supersedes the 2026-09-27 whole-session markdown view),
 * each passage labeled with its actual message id (2026-10-13). The
 * shared markdown engine (core/session-markdown.ts) keeps the full session
 * format for the future user-facing export; the extractor no longer uses
 * it.
 */
/** The whole-record view (used by callers that render a full session;
 *  the pipeline itself batches). TEACHER PROSE ONLY (owner, 2026-09-28),
 *  passages labeled with their message ids (2026-10-13).
 */
export declare function transcriptView(record: ChatRecord): string;
/** The session-only anchor instruction (owner, 2026-10-13, verbatim):
 *  passages arrive labeled "TEACHER [id]" and every proposition must
 *  name the ONE passage it came from — the anchor the merger stamps
 *  into message-granular provenance. Notes have no passages: their
 *  contextualization stays untouched. */
export declare const SESSION_MESSAGE_ID_RULE = "For each new proposition, copy the message ID of the passage that most directly states or explains it into messageId.";
export declare const SESSION_PREAMBLE: string;
export declare const NOTES_PREAMBLE: string;
export declare const EXTRACTION_CORE = "THE GOAL: uncover the source's CORE IDEAS and show how everything derives from the foundations. The\nsource teaches by arguing \u2014 ideas worked out from other ideas, down to a foundation the rest stands on.\nYour deliverable is twofold: the core ideas themselves, and the chains of reasoning that derive them.\nEach chain is premises that JOINTLY entail a conclusion. Entailment is the only link that earns a\nchain \u2014 where the real connection is historical or narrative (who argued what, how a debate or\nexposition unfolds), there is no chain; keep the pieces as bare ideas or drop them. The direction of\nthe graph is upward: foundational ideas at the bottom, derived ideas above them, each chain showing\nhow its conclusion follows from what is more established \u2014 do not submit connections that carry no\nderivation.\n\nThe graph holds TRUE ideas about the world, nothing else \u2014 never anything about the learner, the\nteacher, or this reading: not \"the learner understands X\" but X. A misconception enters as its TRUE\ncorrection. Each statement is one self-contained idea at full precision.\n\nExtract the load-bearing ideas of the subject \u2014 what a reference on it would teach \u2014 not the full run\nof the discourse. An idea earns its place only when the source's arguments run through it \u2014 examples,\nnotation glosses, and restatements that no argument needs are not core ideas. Every idea must stand\nalone for a reader who never saw this source: names and statements may not lean on the source's own\nscaffolding (claim numbering, axiom tags, arc labels); a claim that only matters as part of how this\ndocument is organized is not knowledge \u2014 drop it.\n\nWhen the prompt carries THE GRAPH SO FAR, you are continuing a source already partly extracted: build\non it. Reference an existing idea by its id (\"n_\u2026\") instead of restating it, and prefer chains that\nlean on established conclusions as premises \u2014 derive new material from what is already derived. Do\nnot re-derive a conclusion the graph already holds unless the route is genuinely different.\n\nSUBMIT with one submit_findings call: every NEW core idea with a short name and a precise statement,\nand every chain as premises + conclusion. A chain's premises and conclusion may be ids from this\nsubmission OR existing ids from THE GRAPH SO FAR, verbatim. Premises within one chain are used\nTOGETHER \u2014 independent arguments for the same conclusion are separate chains. A conclusion may\nreappear, by id, as a premise of later chains. A bare idea that no argument uses rides the\npropositions list alone. Include every field even when empty \u2014 \"chains\": [] when the source makes no\narguments. The tool's field descriptions carry the details.";
export declare const EXTRACTOR_INSTRUCTIONS = "You are the extraction stage of a learning application. You read one stretch of a source \u2014 a teaching session, rendered as the teacher's prose in reading order \u2014 and report what it teaches as findings for the learner's global knowledge graph, building on everything already extracted from this source.\n\nTHE GOAL: uncover the source's CORE IDEAS and show how everything derives from the foundations. The\nsource teaches by arguing \u2014 ideas worked out from other ideas, down to a foundation the rest stands on.\nYour deliverable is twofold: the core ideas themselves, and the chains of reasoning that derive them.\nEach chain is premises that JOINTLY entail a conclusion. Entailment is the only link that earns a\nchain \u2014 where the real connection is historical or narrative (who argued what, how a debate or\nexposition unfolds), there is no chain; keep the pieces as bare ideas or drop them. The direction of\nthe graph is upward: foundational ideas at the bottom, derived ideas above them, each chain showing\nhow its conclusion follows from what is more established \u2014 do not submit connections that carry no\nderivation.\n\nThe graph holds TRUE ideas about the world, nothing else \u2014 never anything about the learner, the\nteacher, or this reading: not \"the learner understands X\" but X. A misconception enters as its TRUE\ncorrection. Each statement is one self-contained idea at full precision.\n\nExtract the load-bearing ideas of the subject \u2014 what a reference on it would teach \u2014 not the full run\nof the discourse. An idea earns its place only when the source's arguments run through it \u2014 examples,\nnotation glosses, and restatements that no argument needs are not core ideas. Every idea must stand\nalone for a reader who never saw this source: names and statements may not lean on the source's own\nscaffolding (claim numbering, axiom tags, arc labels); a claim that only matters as part of how this\ndocument is organized is not knowledge \u2014 drop it.\n\nWhen the prompt carries THE GRAPH SO FAR, you are continuing a source already partly extracted: build\non it. Reference an existing idea by its id (\"n_\u2026\") instead of restating it, and prefer chains that\nlean on established conclusions as premises \u2014 derive new material from what is already derived. Do\nnot re-derive a conclusion the graph already holds unless the route is genuinely different.\n\nSUBMIT with one submit_findings call: every NEW core idea with a short name and a precise statement,\nand every chain as premises + conclusion. A chain's premises and conclusion may be ids from this\nsubmission OR existing ids from THE GRAPH SO FAR, verbatim. Premises within one chain are used\nTOGETHER \u2014 independent arguments for the same conclusion are separate chains. A conclusion may\nreappear, by id, as a premise of later chains. A bare idea that no argument uses rides the\npropositions list alone. Include every field even when empty \u2014 \"chains\": [] when the source makes no\narguments. The tool's field descriptions carry the details.\n\nFor each new proposition, copy the message ID of the passage that most directly states or explains it into messageId.";
export declare const NOTES_EXTRACTOR_INSTRUCTIONS = "You are the extraction stage of a learning application. You read one stretch of a source \u2014 the author's personal notes, rendered in reading order \u2014 and report what it teaches as findings for the learner's global knowledge graph, building on everything already extracted from this source.\n\nTHE GOAL: uncover the source's CORE IDEAS and show how everything derives from the foundations. The\nsource teaches by arguing \u2014 ideas worked out from other ideas, down to a foundation the rest stands on.\nYour deliverable is twofold: the core ideas themselves, and the chains of reasoning that derive them.\nEach chain is premises that JOINTLY entail a conclusion. Entailment is the only link that earns a\nchain \u2014 where the real connection is historical or narrative (who argued what, how a debate or\nexposition unfolds), there is no chain; keep the pieces as bare ideas or drop them. The direction of\nthe graph is upward: foundational ideas at the bottom, derived ideas above them, each chain showing\nhow its conclusion follows from what is more established \u2014 do not submit connections that carry no\nderivation.\n\nThe graph holds TRUE ideas about the world, nothing else \u2014 never anything about the learner, the\nteacher, or this reading: not \"the learner understands X\" but X. A misconception enters as its TRUE\ncorrection. Each statement is one self-contained idea at full precision.\n\nExtract the load-bearing ideas of the subject \u2014 what a reference on it would teach \u2014 not the full run\nof the discourse. An idea earns its place only when the source's arguments run through it \u2014 examples,\nnotation glosses, and restatements that no argument needs are not core ideas. Every idea must stand\nalone for a reader who never saw this source: names and statements may not lean on the source's own\nscaffolding (claim numbering, axiom tags, arc labels); a claim that only matters as part of how this\ndocument is organized is not knowledge \u2014 drop it.\n\nWhen the prompt carries THE GRAPH SO FAR, you are continuing a source already partly extracted: build\non it. Reference an existing idea by its id (\"n_\u2026\") instead of restating it, and prefer chains that\nlean on established conclusions as premises \u2014 derive new material from what is already derived. Do\nnot re-derive a conclusion the graph already holds unless the route is genuinely different.\n\nSUBMIT with one submit_findings call: every NEW core idea with a short name and a precise statement,\nand every chain as premises + conclusion. A chain's premises and conclusion may be ids from this\nsubmission OR existing ids from THE GRAPH SO FAR, verbatim. Premises within one chain are used\nTOGETHER \u2014 independent arguments for the same conclusion are separate chains. A conclusion may\nreappear, by id, as a premise of later chains. A bare idea that no argument uses rides the\npropositions list alone. Include every field even when empty \u2014 \"chains\": [] when the source makes no\narguments. The tool's field descriptions carry the details.";
export declare function sourceDigest(graph: DerivedGraph, sourceId: string): string;
/** The pipeline phases, in order — what the home status endpoint shows.
 *  The post-batch embedding tail was its own phase (accuracy wave,
 *  2026-09-19) until wave 7 killed the embedder seam wholesale (this
 *  interlude) — birth-session clusters need no post-merge pass. The
 *  phases tell the truth about what the job is actually waiting on.
 *  "queued" (owner, 2026-09-28): the global extract semaphore — 3
 *  concurrent extractor calls process-wide; the job is waiting for an
 *  extract slot, not for the model.
 *  "waiting" (owner 2026-09-28): the serialized-audit gate — the job's
 *  audit+merge critical section is queued behind another job's; the
 *  extractor is done but the auditor may not start until the graph is
 *  stable. */
export type ExtractionPhase = "queued" | "extracting" | "waiting" | "auditing" | "merging";
/** One in-flight pipeline run. Module-level: one process, one registry.
 *  Exported for the status payload's consumer typing (the dock). */
export interface RunningExtraction {
    /** The SOURCE id (chat id / notes src id) — the payload's identity and
     *  the abort key. The registry KEY adds "#i" for chunk jobs (a
     *  multi-chunk source owns several entries); this field stays the
     *  source id so the feed's reveal logic and abort stay source-scoped. */
    chatId: string;
    /** PER-CHUNK JOBS (owner, 2026-09-28): which chunk of how many this
     *  job is — present only when the source fanned out (n > 1). Drives
     *  the feed row's "· i/N" suffix. */
    part?: {
        i: number;
        n: number;
    };
    /** Which front door the run came through — label + usage-persistence
     *  depend on it (chats bill their chat record; notes bill the source
     *  record). */
    kind: "chat" | "notes";
    /** Display label (the file path for notes imports); the status route
     *  falls back to the chat store for chat runs. */
    label?: string;
    phase: ExtractionPhase;
    startedAt: number;
    /** Live per-stage usage, accumulated as steps bill (the dock's cost /
     *  context-window blobs read this through /api/graph/status). */
    usage: {
        extractor?: ExtractionStageUsage;
        auditor?: ExtractionStageUsage;
    };
    /** True-cancellation handle (the dock's abort button): one controller per
     *  run, shared across phases; abort() cancels the in-flight model call. */
    controller: AbortController;
}
/** In-flight pipeline runs (oldest first) — the /api/graph/status payload. */
export declare function extractionStatuses(): RunningExtraction[];
/** True cancellation of the in-flight run for a chat (the dock's abort
 *  button): the pending model call receives the signal — the provider
 *  cancels the request, spend stops — and the run ends like a failure:
 *  nothing merged, nothing checkpointed, partial usage still persisted.
 *  Returns false when no run is in flight (idempotent no-op). */
export declare function abortExtraction(chatId: string): boolean;
export interface ExtractionModels {
    /** Test seam: a scripted engine per stage — checked FIRST, ahead of the
     *  engineFor chain (production wires no direct values). */
    extractor?: PiEngine;
    auditor?: PiEngine;
    /** Settings-resolved engine per role — the same slot treatment the
     *  job runner got, read FRESH per stage call (a settings PUT between
     *  stages lands). BYOK (owner, 2026-09-22): the chain (role override →
     *  slot → NOTHING) may end EMPTY → undefined; the front doors refuse
     *  with ModelsNotConfiguredError before any stage runs. */
    engineFor?: (role: ModelRole) => PiEngine | undefined;
    /** Key-presence gate (provider-key interlude, 2026-09-25): given a
     *  stage engine's provider + the role's slot tier, the injected check
     *  returns the refusal envelope when the provider's key is missing
     *  (null = run). Same injection discipline as the job runner's seam
     *  (the agent layer may not read the key store); absent in tests that
     *  inject engines directly (test engines never owe a key). A keyless
     *  stage refuses with ProviderKeyMissingError BEFORE any batch runs. */
    providerKeyMissing?: (provider: string, tier: ModelSlotName) => ProviderKeyMissing | null;
}
export interface ExtractionPipelineDeps extends GraphDeps, ExtractionModels {
    /** The chunk budget — the transcript-token share of the extractor's
     *  context; batches fill to it (the trigger fires on the same number,
     *  read fresh per turn by the composition root). OPTIONAL with the
     *  factory default (4096) so test fixtures stay minimal; the server
     *  callers wire the live effective settings (extraction-UX redesign,
     *  2026-09-24). */
    getChunkTokens?: () => number;
}
export interface NotesImportInput {
    /** The source's file path — its identity (deterministic src id) AND its
     *  provenance label in the detail card. */
    filePath: string;
    /** The file's raw content, VERBATIM — any format. */
    text: string;
}
/** A notes import did not finish. Earlier graph writes and billed usage are
 * retained; partialStats describe known merges, not an all-or-nothing result. */
export declare class NotesImportError extends Error {
    readonly outcome: "failed" | "partial" | "aborted" | "busy";
    readonly partialStats: EmissionStats;
    constructor(outcome: "failed" | "partial" | "aborted" | "busy", partialStats: EmissionStats, message: string, options?: ErrorOptions);
}
export interface ExtractionPipeline {
    /** Extract + audit + merge ONE chat. Single-flight per chat; resolves to
     *  the merger's append stats (or throws — no checkpoint on failure). */
    runExtraction(chatId: string): Promise<EmissionStats>;
    /** The format-agnostic front door (2026-09-13): run the same pipeline
     *  over ONE raw notes file. The source id is deterministic per file
     *  path, so re-importing the same file re-runs extraction against the
     *  same source identity (mappings dedupe by it). */
    importNotes(input: NotesImportInput): Promise<EmissionStats>;
}
/** pi's per-step usage, flattened to the persisted CallUsage fields
 *  (the money channel's capture shape, contracts/chat.ts). Exported for
 *  the cluster namer — the same capture shape (2026-09 graph cost
 *  metrics wave). Module scope: no closure deps, pure projection. */
export declare function callUsage(usage: Usage): CallUsage;
export declare function createExtractionPipeline(deps: ExtractionPipelineDeps): ExtractionPipeline;
//# sourceMappingURL=extraction.d.ts.map