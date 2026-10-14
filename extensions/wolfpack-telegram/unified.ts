/**
 * Wolfpack Telegram Extension — Unified Implementation (Pi-Durable Only)
 * 
 * Provides Telegram tools: buttons, keyboard, attach, react.
 * Uses shared state from context for coordination with harness telegram client.
 */
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  defineExtension,
  defineTool,
  section,
  Type,
  type ExtensionContext,
  type ToolContext,
  type TelegramSharedState,
  type TelegramButton,
  type ReplyKeyboard,
  type TelegramAttachment,
} from "@wolfpack/harness/extension";

const MAX_ATTACHMENTS_PER_TURN = 10;

// ─── Config ────────────────────────────────────────────────────────────────

export interface TelegramConfig {
  /** Environment variable name for bot token (default: TELEGRAM_BOT_TOKEN) */
  tokenEnv?: string;
  /** Telegram user ID of the owner (for access control) */
  ownerId?: number;
}

// ─── Fallback State (when not injected) ────────────────────────────────────

function createFallbackState(): TelegramSharedState {
  return {
    queuedButtons: new Map(),
    queuedReplyKeyboards: new Map(),
    queuedReactions: new Map(),
    queuedAttachments: new Map(),
    validReactions: new Set([
      "❤", "👍", "👎", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩",
      "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭",
      "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈",
      "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗",
      "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊",
      "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡"
    ]),
  };
}

// ─── Extension Factory ─────────────────────────────────────────────────────

export default function createTelegramExtension(
  config: TelegramConfig,
  context: ExtensionContext
): ReturnType<typeof defineExtension> {
  // Use injected state from harness, or create fallback
  const state: TelegramSharedState = context.telegram ?? createFallbackState();
  
  return defineExtension({
    name: "wolfpack-telegram",
    runtimes: ["pi-durable"],

    sections: [
      section("telegram_instructions", () => {
        return `
## Telegram Bridge

Messages from Telegram are prefixed with "[telegram]".

### Tools

- **telegram_buttons** — Inline buttons below your message. callback_data sent as next message.
- **telegram_keyboard** — Large reply keyboard below input. Button text sent as next message.
- **telegram_react** — React to the message with an emoji (no text reply needed).
- **telegram_attach** — Send a local file as attachment.

### ALWAYS use buttons for choices

Whenever you ask a question with discrete options (yes/no, task type, domain, etc.):
1. Call telegram_buttons with those options
2. Then ask your question

Never ask a multiple-choice question without first calling telegram_buttons.

### Notes

- Incoming files: path included in message, read with standard tools.
- Valid reactions: 👍 👎 ❤ 🔥 👏 🎉 🤔 😱 😢 👀 😍 😡 and others.`.trim();
      }),
    ],

    tools: [
      defineTool({
        name: "telegram_attach",
        description: "Queue one or more local files to be sent with the next Telegram reply.",
        parameters: Type.Object({
          paths: Type.Array(
            Type.String({ description: "Local file path to attach" }),
            { minItems: 1, maxItems: MAX_ATTACHMENTS_PER_TURN }
          ),
        }),
        async execute(params: { paths: string[] }, ctx: ToolContext) {
          const convId = String(ctx.conversationId);
          let attachments = state.queuedAttachments.get(convId);
          if (!attachments) {
            attachments = [];
            state.queuedAttachments.set(convId, attachments);
          }

          const added: string[] = [];
          for (const inputPath of params.paths) {
            const stats = await stat(inputPath);
            if (!stats.isFile()) {
              throw new Error(`Not a file: ${inputPath}`);
            }
            if (attachments.length >= MAX_ATTACHMENTS_PER_TURN) {
              throw new Error(`Attachment limit reached (${MAX_ATTACHMENTS_PER_TURN})`);
            }
            attachments.push({ path: inputPath, fileName: basename(inputPath) });
            added.push(inputPath);
          }

          return {
            content: [{ type: "text" as const, text: `Queued ${added.length} Telegram attachment(s).` }],
          };
        },
      }),

      defineTool({
        name: "telegram_buttons",
        description: "Add inline buttons below your next Telegram reply. When clicked, the button's callback_data is sent as the next user message.",
        parameters: Type.Object({
          buttons: Type.Array(
            Type.Array(
              Type.Object({
                text: Type.String({ description: "Button label shown to user" }),
                callback_data: Type.String({ description: "Data sent when button is clicked (max 64 chars)" }),
              }),
              { description: "Row of buttons" }
            ),
            { description: "Rows of buttons", minItems: 1, maxItems: 5 }
          ),
        }),
        async execute(params: { buttons: Array<Array<{ text: string; callback_data: string }>> }, ctx: ToolContext) {
          const convId = String(ctx.conversationId);
          const rows: TelegramButton[][] = params.buttons.map(row =>
            row.map(btn => ({
              text: btn.text,
              callbackData: btn.callback_data.slice(0, 64),
            }))
          );
          state.queuedButtons.set(convId, rows);
          return {
            content: [{ type: "text" as const, text: `Queued ${rows.length} row(s) of inline buttons.` }],
          };
        },
      }),

      defineTool({
        name: "telegram_keyboard",
        description: "Add a large reply keyboard below the input box. Button text is sent as the next user message.",
        parameters: Type.Object({
          buttons: Type.Array(
            Type.Array(
              Type.String({ description: "Button text" }),
              { description: "Row of buttons" }
            ),
            { description: "Rows of buttons", minItems: 1, maxItems: 6 }
          ),
          one_time: Type.Optional(Type.Boolean({ description: "Hide keyboard after use (default: true)" })),
          placeholder: Type.Optional(Type.String({ description: "Input placeholder text" })),
        }),
        async execute(params: { buttons: string[][]; one_time?: boolean; placeholder?: string }, ctx: ToolContext) {
          const convId = String(ctx.conversationId);
          const keyboard: ReplyKeyboard = {
            keyboard: params.buttons,
            oneTime: params.one_time ?? true,
            resize: true,
            placeholder: params.placeholder,
          };
          state.queuedReplyKeyboards.set(convId, keyboard);
          return {
            content: [{ type: "text" as const, text: `Queued reply keyboard with ${params.buttons.length} row(s).` }],
          };
        },
      }),

      defineTool({
        name: "telegram_react",
        description: "React to the user's message with an emoji. Use instead of a text reply when appropriate.",
        parameters: Type.Object({
          emoji: Type.String({
            description: "Reaction emoji (👍 👎 ❤ 🔥 👏 🎉 🤔 😱 😢 👀 😍 😡 etc.)",
          }),
        }),
        async execute(params: { emoji: string }, ctx: ToolContext) {
          const convId = String(ctx.conversationId);
          const emoji = params.emoji.trim();
          
          if (!state.validReactions.has(emoji)) {
            return {
              content: [{ type: "text" as const, text: `Invalid reaction emoji: ${emoji}` }],
              isError: true,
            };
          }
          
          state.queuedReactions.set(convId, emoji);
          return {
            content: [{ type: "text" as const, text: `Queued reaction: ${emoji}` }],
          };
        },
      }),
    ],
  });
}
