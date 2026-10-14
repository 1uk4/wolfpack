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
import type {
  Extension,
  Tool,
  Section,
  ToolContext,
  SectionContext,
  HookContext,
} from "../extension-api.js";

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
        const context: ToolContext = {
          cwd: wolfDen,
          wolfDen,
          wolfName,
          conversationId: Number(api.conversationId),
        };
        return tool.execute(args, context);
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
          const context: HookContext = {
            wolfDen,
            wolfName,
            conversationId: Number(api.conversationId),
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
