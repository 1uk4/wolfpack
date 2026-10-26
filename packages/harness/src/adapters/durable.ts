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
  type Extension as PiDurableExtension,
} from "@earendil-works/pi-durable";
import type { AssistantMessage as PiAssistantMessage } from "@earendil-works/pi-ai";
import { conversationReaderFor } from "../engine/conversation-reader.js";
import type {
  Extension,
  Tool,
  Section,
  ToolContext,
  ToolResult,
  SectionContext,
  HookContext,
} from "../extension-api.js";

/**
 * Unified tool result → pi-durable's result. pi-durable reads the model-facing
 * text from `output` (not `content`); passing `content` through left every
 * extension tool's output empty, and an empty error result is rejected by the
 * API ("content cannot be empty if is_error is true"), wedging the
 * conversation. An error always carries text.
 */
export function toDurableResult(result: ToolResult): { output: ToolResult["content"]; isError?: boolean } {
  const content = (result.content ?? []).filter((c) => c.type !== "text" || c.text.trim() !== "");
  if (result.isError) {
    return {
      output: content.length ? content : [{ type: "text", text: "Tool failed without an error message." }],
      isError: true,
    };
  }
  return { output: content };
}

interface AdapterConfig {
  wolfDen: string;
  wolfName: string;
}

/**
 * Adapt a unified Extension to pi-durable format.
 */
export function adaptToDurable(
  ext: Extension,
  config: AdapterConfig
): PiDurableExtension {
  const { wolfDen, wolfName } = config;

  // Adapt tools
  const tools = (ext.tools ?? []).map((tool) =>
    piDefineTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      async execute(args, api) {
        const conversationId = Number(api.conversationId);
        const reader = conversationReaderFor(wolfDen);
        const context: ToolContext = {
          cwd: wolfDen,
          wolfDen,
          wolfName,
          conversationId,
          ...(reader
            ? {
                conversation: {
                  classify: () => reader.classify(conversationId),
                  classifyOther: (id: number) => reader.classify(id),
                  messagesSince: (after?: number) => reader.messagesSince(conversationId, after),
                },
              }
            : {}),
        };
        return toDurableResult(await tool.execute(args, context));
      },
    })
  );

  // Adapt sections
  const sections = (ext.sections ?? []).map((sec) =>
    piSection(sec.name, () => {
      const context: SectionContext = {
        wolfDen,
        wolfName,
        conversationId: 1, // Sections are always root context
      };
      return sec.render(context);
    })
  );

  // Adapt hooks
  const hooks = [];
  if (ext.hooks?.afterResponse) {
    const afterResponse = ext.hooks.afterResponse;
    hooks.push(
      hook(GenerationTask, {
        afterResponse: (message: PiAssistantMessage, api) => {
          const conversationId = Number(api.conversationId);
          const reader = conversationReaderFor(wolfDen);
          const context: HookContext = {
            wolfDen,
            wolfName,
            conversationId,
            ...(reader
              ? {
                  conversation: {
                    classify: () => reader.classify(conversationId),
                    classifyOther: (id) => reader.classify(id),
                    messagesSince: (after) => reader.messagesSince(conversationId, after),
                    onEngineClose: (fn) => reader.onClose(fn),
                    hostConsolidationTimer: reader.hostConsolidationTimer === true,
                  },
                }
              : {}),
          };
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

  return piDefineExtension({
    name: ext.name,
    tools,
    sections,
    hooks,
  });
}
