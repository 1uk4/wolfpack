/**
 * Pi-Durable Adapter
 * 
 * Converts unified Extension interface to @earendil-works/pi-durable format.
 */
import {
  defineExtension as piDefineExtension,
  defineTool as piDefineTool,
  section as piSection,
  hook,
  GenerationTask,
  CompactionTask,
  type Extension as PiDurableExtension,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { AssistantMessage as PiAssistantMessage } from "@earendil-works/pi-ai";
import { cardResult } from "../engine/cards.js";
import { conversationReaderFor, onEngineCloseFor } from "../engine/conversation-reader.js";
import type {
  Extension,
  Tool,
  Section,
  ToolContext,
  ToolResult,
  SectionContext,
  HookContext,
  ConversationReads,
} from "../extension-api.js";

/**
 * Unified tool result → pi-durable's result. pi-durable reads the model-facing
 * text from `output` (not `content`); passing `content` through left every
 * extension tool's output empty, and an empty error result is rejected by the
 * API ("content cannot be empty if is_error is true"), wedging the
 * conversation. An error always carries text.
 */
export function toDurableResult(result: ToolResult): Omit<ToolExecutionResult, "output"> & { output: ToolResult["content"] } {
  const content = (result.content ?? []).filter((c) => c.type !== "text" || c.text.trim() !== "");
  if (result.isError) {
    return {
      output: content.length ? content : [{ type: "text", text: "Tool failed without an error message." }],
      isError: true,
    };
  }
  // A card result carries the card in details (see engine/cards.ts) and always terminates the run.
  if (result.card) {
    const raised = cardResult(result.card, content.map((c) => c.text).join("\n") || undefined);
    return raised;
  }
  return { output: content };
}

interface AdapterConfig {
  wolfDen: string;
  wolfName: string;
  /** Called with the name of every tool declaring `raisesCard` (wire to the wolf's card guard). */
  onCardTool?: (name: string) => void;
}

/**
 * Adapt a unified Extension to pi-durable format.
 */
export function adaptToDurable(
  ext: Extension,
  config: AdapterConfig
): PiDurableExtension {
  const { wolfDen, wolfName } = config;

  /** The `{ conversation }` slice of a hook/tool/section context: present once the engine's reader is registered. */
  const readsFor = (conversationId: number): { conversation?: ConversationReads } => {
    const reader = conversationReaderFor(wolfDen);
    if (!reader) return {};
    return {
      conversation: {
        classify: () => reader.classify(conversationId),
        classifyOther: (id: number) => reader.classify(id),
        messagesSince: (after?: number) => reader.messagesSince(conversationId, after),
        onEngineClose: (fn) => reader.onClose(fn),
        hostConsolidationTimer: reader.hostConsolidationTimer === true,
      },
    };
  };

  // Adapt tools
  for (const t of ext.tools ?? []) if (t.raisesCard) config.onCardTool?.(t.name);
  const tools = (ext.tools ?? []).map((tool) =>
    piDefineTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      async execute(args, api) {
        const conversationId = Number(api.conversationId);
        const context: ToolContext = { cwd: wolfDen, wolfDen, wolfName, conversationId, ...readsFor(conversationId) };
        return toDurableResult(await tool.execute(args, context));
      },
    })
  );

  // Adapt sections
  const sections = (ext.sections ?? []).map((sec) =>
    piSection(sec.name, (input) => {
      // pi-durable renders sections per request with PromptInput.conversationId: the conversation being prompted.
      const conversationId = Number(input.conversationId);
      const context: SectionContext = { wolfDen, wolfName, conversationId, ...readsFor(conversationId) };
      return sec.render(context);
    })
  );

  // Adapt hooks
  const hooks = [];
  if (ext.hooks?.beforeCompact) {
    const beforeCompact = ext.hooks.beforeCompact;
    hooks.push(
      hook(CompactionTask, {
        beforeCompact: async (compaction, api, ctx) => {
          const conversationId = Number(api.conversationId);
          const context: HookContext = { wolfDen, wolfName, conversationId, ...readsFor(conversationId) };
          try {
            await beforeCompact({ reason: compaction.reason, signal: ctx.abortSignal }, context);
          } catch (err) {
            // Capturing is best effort: it must never block or fail a compaction.
            console.error("[harness] beforeCompact hook failed:", err instanceof Error ? err.message : err);
          }
          return undefined;
        },
      })
    );
  }
  if (ext.hooks?.afterResponse) {
    const afterResponse = ext.hooks.afterResponse;
    hooks.push(
      hook(GenerationTask, {
        afterResponse: (message: PiAssistantMessage, api) => {
          const conversationId = Number(api.conversationId);
          const context: HookContext = { wolfDen, wolfName, conversationId, ...readsFor(conversationId) };
          // Convert pi-durable message to unified format
          const unifiedMessage = {
            content: message.content.map((block) => {
              if (block.type === "text") {
                return { type: "text" as const, text: block.text };
              } else if (block.type === "toolCall") {
                return {
                  type: "toolCall" as const,
                  name: block.name,
                  arguments: block.arguments,
                };
              } else if (block.type === "thinking") {
                return { type: "thinking" as const, thinking: block.thinking };
              }
              return { type: "text" as const, text: "" };
            }),
          };
          afterResponse(unifiedMessage, context);
        },
      })
    );
  }

  // pi-durable has no extension lifecycle of its own: run `lifecycle.stop` when the engine closes (queued if the engine
  // is not attached yet), so stop-time cleanup never depends on a conversation having run.
  const stop = ext.lifecycle?.stop;
  if (stop) onEngineCloseFor(wolfDen, () => void Promise.resolve(stop()).catch(() => {}));

  return piDefineExtension({
    name: ext.name,
    tools,
    sections,
    hooks,
  });
}
