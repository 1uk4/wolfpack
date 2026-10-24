import { type AgentSettings, type CompactionSettings, type GraphSettings, type ModelSlotName, type ModelsSettings } from "@/src/core";
/** The search engines this wave ships (src/core/search.ts) + their labels. */
declare const SEARCH_ENGINES: readonly ["tavily", "brave"];
/** The owner's final toggleable-tool list (confirm with the user before
 *  changing — the Teacher stream settled this 2026-09-19). */
export declare const TOGGLE_TOOLS: readonly ["research", "demo", "visual", "pdf"];
/** SegmentInfo as GET /api/settings/prompts returns it. */
interface SegmentInfo {
    path: string;
    sourceText: string;
    overrideText: string | null;
    enabled: boolean;
    shared: boolean;
}
/** Compose: one tool toggled, the rest of the section carried verbatim.
 *  Pure — exported for tests. */
export declare function composeTool(agent: AgentSettings | undefined, id: string, on: boolean): AgentSettings;
/** The quizzing mechanics (owner 2026-09-27): a segmented control, not a
 *  toggle — exactly one mechanic is ever active. `explain: true` arms
 *  free-recall (explain in, quiz out); anything else is multiple choice.
 *  `quiz` itself is never written (mechanics-managed — see quizMechanics
 *  in agent/tools.ts). Pure — exported for tests. */
export declare function composeQuizMechanics(agent: AgentSettings | undefined, mechanics: "choice" | "free"): AgentSettings;
/** Compose the prober graph-tools toggle (wave 7): its own key in the
 *  agent section — never in the tool-toggles map (owner ruling). Absent =
 *  ON (the toggle discipline); the write is explicit either way, so an
 *  explicit-off record stays visible as stored. Pure — exported for tests. */
export declare function composeGraphTools(agent: AgentSettings | undefined, on: boolean): AgentSettings;
/** The research tool runs on the search port — the teacher registry DROPS
 *  it when no engine is live (chat-handler's searchAvailable, the same
 *  /api/search signal the section fetches). Pure — exported for tests.
 *  Teacher-stream flag 2026-09-22: the settings row grays on the SAME
 *  signal, so the row and the actual registry availability can never
 *  disagree. `search === null` (loading/failed) grays NOTHING. */
export declare function researchToolUnavailable(toolId: string, search: {
    available: boolean;
} | null): boolean;
/** Compose: one slot's model/thinking override. Empty model = absent
 *  override (Default — falls to the factory pin); empty thinking = the
 *  tier keeps its resolved thinking budget. Per-field independence, same
 *  as the schema's ModelSlot. Pure — exported for tests. */
export declare function composeSlotModel(models: ModelsSettings | undefined, slot: ModelSlotName, provider: string, id: string, thinking: string): ModelsSettings;
/** Compose: the search-engine preference. null = the explicit pin is
 *  REMOVED (auto-activation takes over — the schema's resting state).
 *  Pure — exported for tests. */
export declare function composeSearchEngine(agent: AgentSettings | undefined, engine: (typeof SEARCH_ENGINES)[number] | null): AgentSettings;
/** The indicator under a row whose override IS the version in use (owner
 *  ruling, refined 2026-09-26: the small text states WHICH VERSION IS
 *  IN USE — "Your version is in use" when the switch is on, and NOTHING
 *  when the default composes, even if a saved override sits on disk
 *  unused. The switch's meaning becomes legible: it visibly controls
 *  this line). Exported for the pin. */
export declare const PROMPT_IN_USE_HINT = "Your version is in use";
/** One section of the prompt view — the owner's ruled order: Teacher,
 *  Prober, then Shared last. */
export interface PromptSection {
    id: "teacher" | "prober" | "shared";
    label: string;
    /** The one header that earns a hint: "Shared" alone is not
     *  self-evident. Teacher/Prober are. */
    hint?: string;
    segments: SegmentInfo[];
}
/** Split the server's per-agent segment lists into the owner's three
 *  sections. The server contract returns the shared segments in BOTH
 *  lists (same paths, same content) — the shared chunks are listed ONCE
 *  here (taken from the teacher list; identical by construction), in
 *  assembly order: the base file, then the shared fragments sorted. The
 *  agents' own chunks keep their lists' order — which IS the prompt
 *  assembly order (numeric-prefix filename sort). Pure — exported for
 *  tests. */
export declare function sectionedSegments(view: {
    prober: SegmentInfo[];
    teacher: SegmentInfo[];
}): PromptSection[];
/** Compose: one prompt switch. on = explicit true; off = key REMOVED
 *  (absent = off is the schema's resting state; explicit false is the
 *  same thing but noisier). Pure — tests. */
export declare function composePromptSwitch(agent: AgentSettings | undefined, path: string, on: boolean): AgentSettings;
export declare function AgentSection({ agent, models, graph, compaction, onSectionChange, onModelsChange, onCompactionChange, }: {
    agent: AgentSettings | undefined;
    /** The `models` section (slot pins — engine-level, PUT /api/settings/models). */
    models: ModelsSettings | undefined;
    /** The `graph` section — READ ONLY here: the graphTools row composes its
     *  master switch (graph.enabled off dims + disables the row; the
     *  effective gate is server-side, per-turn fresh). */
    graph: GraphSettings | undefined;
    /** The `compaction` section — its own PUT (the threshold is engine
     *  behavior, not an agent-section key; owner round 14, Agent tab). */
    compaction: CompactionSettings | undefined;
    /** Writes the composed WHOLE agent section (replace-PUT discipline). */
    onSectionChange: (next: AgentSettings) => void;
    /** Writes the composed models section (slots — replace-PUT discipline). */
    onModelsChange: (next: ModelsSettings) => void;
    /** Writes the whole compaction section (replace-PUT discipline). */
    onCompactionChange: (next: CompactionSettings) => void;
}): any;
export {};
//# sourceMappingURL=agent-section.d.ts.map