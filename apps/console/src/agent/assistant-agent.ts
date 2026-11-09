import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { providerEventObserver } from "./provider-events.ts";
import { APP_IDENTITY, type PiEngine } from "./models.ts";
import fs from "node:fs";
import { PATHS } from "../../config.ts";
import { toLlmMessages } from "../core/native-messages.ts";

/**
 * The console's one conversation agent: a plain assistant. The STATELESS
 * per-turn engine (docs/pi-engine-swap.md §2): the persisted record is the
 * source of truth, the agent is rebuilt from it every POST and discarded at
 * turn end. Engines are injectable so tests can pass a scripted faux engine.
 *
 * The system prompt is src/agent/system-prompt.md, read once at module load.
 */
const systemPromptText = (() => {
	try {
		return fs.readFileSync(PATHS.systemPrompt, "utf-8").trim();
	} catch {
		return ""; // source unreadable — same empty fallback the segment loader had
	}
})();

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
	/** Native conversation identity: the existing persisted chat id.
	 * Debug: when set AND WOLFPACK_PROVIDER_EVENTS=1, raw provider stream events
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
	const systemPrompt = systemPromptText;
	// Debug recorder: raw provider events when WOLFPACK_PROVIDER_EVENTS=1 and the
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
