import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { providerEventObserver } from "./provider-events.ts";
import { APP_IDENTITY, type PiEngine } from "./models.ts";
import { effectivePromptSegments } from "./prompt-segments.ts";
import { toLlmMessages } from "../core/native-messages.ts";

/**
 * The console's one conversation agent: a plain assistant. The STATELESS
 * per-turn engine (docs/pi-engine-swap.md §2): the persisted record is the
 * source of truth, the agent is rebuilt from it every POST and discarded at
 * turn end. Engines are injectable so tests can pass a scripted faux engine.
 *
 * The system prompt is COMPOSED from src/agent/system-prompt.md (the only
 * source segment) through effectivePromptSegments, so per-segment user
 * overrides keep riding the same path.
 */

/** Which agent's prompt to compose. */
export type AgentKind = "assistant";

/** Exported for tests: assert what composes into the model's prompt. A
 *  segment whose switch is ON and whose override file exists composes the
 *  override text instead of the source; `switches` is the settings
 *  record's agent.prompts map (absent key = off). */
export function composeInstructions(kind: AgentKind, switches?: Record<string, boolean>): string {
	const segments = effectivePromptSegments(kind, switches ?? {});
	return segments
		.map((s) => (s.enabled ? s.overrideText! : s.sourceText))
		.map((t) => t.trim())
		.filter(Boolean)
		.join("\n\n---\n\n");
}

// The switch-free source composition (module-load once). With
// promptSwitches provided, baseAgentOptions composes FRESH per turn.
const composedInstructions: Record<AgentKind, string> = {
	assistant: composeInstructions("assistant"),
};

// Money channel (wave 4): the chat-handler passes a per-turn collector;
// every model call's usage lands in the chat record's turns log
// (ChatStore.appendTurnUsage). The narrow param keeps the seam honest.
export type StepUsageCollector = (usage: Usage) => void;

/** Per-request construction options (the handler wires all of these). */
export interface AgentBuildOptions {
	/** Model + stream function — tests inject a scripted faux engine. */
	engine?: PiEngine;
	/** The initial transcript, as pi messages (the record IS agent state). */
	messages?: AgentMessage[];
	/** Money channel: one call per model request. */
	onUsage?: StepUsageCollector;
	/** Tests may pass a bare tool registry to drive deterministic flows. */
	tools?: Record<string, AgentTool<any>>;
	/** Per-segment system-prompt override SWITCHES (the settings record's
	 *  agent.prompts map, absent key = off — same keys the settings routes
	 *  and effectivePromptSegments use). Provided → the prompt composes
	 *  fresh per turn, honoring enabled overrides (switch on + file
	 *  exists); absent → the cached pure-source composition. */
	promptSwitches?: Record<string, boolean>;
	/** Native conversation identity: the existing persisted chat id.
	 * Debug: when set AND LH_PROVIDER_EVENTS=1, raw provider stream events
	 *  (pre-normalization) append to data/debug/provider-events/
	 *  <chatId>.jsonl via providerEventObserver — the GLM-truncation /
	 *  DeepSeek-id incident layer. Absent or env-off → no observer. */
	chatId?: string;
}

/**
 * The assistant: no tools by default (tests may inject a bare registry via
 * opts.tools), the base system prompt, BYOK engine from the handler.
 */
export function createAssistantAgent(opts: AgentBuildOptions = {}) {
	const engine = opts.engine;
	if (!engine) throw new Error("createAssistantAgent: no engine — the turn gate resolves one from the model slots");
	const systemPrompt = opts.promptSwitches
		? composeInstructions("assistant", opts.promptSwitches)
		: composedInstructions.assistant;
	// Debug recorder: raw provider events when LH_PROVIDER_EVENTS=1 and the
	// caller handed a chatId; undefined is the normal no-observer path.
	const providerEvents = opts.chatId ? providerEventObserver(opts.chatId, "assistant") : undefined;
	const agent = new Agent({
		identity: APP_IDENTITY,
		sessionId: opts.chatId,
		initialState: {
			systemPrompt,
			model: engine.model,
			thinkingLevel: engine.level,
			tools: Object.values(opts.tools ?? {}),
			messages: opts.messages ?? [],
		},
		streamFn: engine.streamFn,
		...(providerEvents ? { onProviderStreamEvent: providerEvents } : {}),
		// "all" joins every steer handed to a live run at one boundary,
		// matching the idle wake's carry-everything semantics.
		steeringMode: "all",
		// THE app seam: markers flatten to their canonical user text, UI-only
		// markers drop, the app's id fields strip. Must never throw.
		convertToLlm: toLlmMessages,
	});
	if (opts.onUsage) {
		agent.subscribe((event: AgentEvent) => {
			if (event.type === "message_end" && event.message.role === "assistant" && "usage" in event.message) {
				// A cancelled call is not a billed step.
				if (event.message.stopReason === "aborted") return;
				opts.onUsage!(event.message.usage);
			}
		});
	}
	return agent;
}

export type AssistantAgent = ReturnType<typeof createAssistantAgent>;
