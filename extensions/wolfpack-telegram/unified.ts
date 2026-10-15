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

- **telegram_send** — Send a standalone message separate from your reply. Use when a message must exist independently (e.g. to pin it or reference it later). Returns the message ID.
- **telegram_buttons** — Inline buttons below your reply. callback_data sent as next message.
- **telegram_keyboard** — Large reply keyboard below input. Button text sent as next message.
- **telegram_pin** — Pin a message. Use message_id='last' to pin the most recent bot message.
- **telegram_unpin** — Unpin a message by ID.
- **telegram_edit** — Edit a previously sent message's text. Use message_id='last' for the most recent. Supports MarkdownV2.
- **telegram_react** — React to the message with an emoji (no text reply needed).
- **telegram_attach** — Send a local file as attachment.

### Sending patterns

- Your reply text is always one message. To send MULTIPLE messages in one turn, use telegram_send for the extras.
- To pin something: telegram_send the content, then telegram_pin with message_id="last".
- To update a message later: save the message ID from telegram_send, then use telegram_edit.

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
        name: "telegram_send",
        description: "Send a standalone message separate from your reply. Use for the workout card or any message that must be its own message (e.g. to pin independently).",
        parameters: Type.Object({
          text: Type.String({ description: "Message text" }),
          parse_mode: Type.Optional(Type.String({ description: "Parse mode: MarkdownV2 or HTML (optional)" })),
        }),
        async execute(params: { text: string; parse_mode?: string }) {
          if (!state.botApi) {
            return { content: [{ type: "text" as const, text: "Bot API not available" }], isError: true };
          }
          const chatId = state.botApi.getChatId();
          if (!chatId) {
            return { content: [{ type: "text" as const, text: "No active chat" }], isError: true };
          }
          const msgId = await state.botApi.sendMessage(chatId, params.text, params.parse_mode);
          return { content: [{ type: "text" as const, text: `Sent message ${msgId}` }] };
        },
      }),

      defineTool({
        name: "telegram_pin",
        description: "Pin a message in the chat. Use 'last' to pin the most recently sent message.",
        parameters: Type.Object({
          message_id: Type.String({ description: "Message ID to pin, or 'last' for the most recent bot message" }),
        }),
        async execute(params: { message_id: string }) {
          if (!state.botApi) {
            return { content: [{ type: "text" as const, text: "Bot API not available" }], isError: true };
          }
          const chatId = state.botApi.getChatId();
          if (!chatId) {
            return { content: [{ type: "text" as const, text: "No active chat" }], isError: true };
          }
          const msgId = params.message_id === "last" ? state.botApi.getLastMessageId() : parseInt(params.message_id);
          if (!msgId) {
            return { content: [{ type: "text" as const, text: "No message to pin" }], isError: true };
          }
          await state.botApi.pinChatMessage(chatId, msgId);
          return { content: [{ type: "text" as const, text: `Pinned message ${msgId}` }] };
        },
      }),

      defineTool({
        name: "telegram_unpin",
        description: "Unpin a message in the chat.",
        parameters: Type.Object({
          message_id: Type.String({ description: "Message ID to unpin" }),
        }),
        async execute(params: { message_id: string }) {
          if (!state.botApi) {
            return { content: [{ type: "text" as const, text: "Bot API not available" }], isError: true };
          }
          const chatId = state.botApi.getChatId();
          if (!chatId) {
            return { content: [{ type: "text" as const, text: "No active chat" }], isError: true };
          }
          await state.botApi.unpinChatMessage(chatId, parseInt(params.message_id));
          return { content: [{ type: "text" as const, text: `Unpinned message ${params.message_id}` }] };
        },
      }),

      defineTool({
        name: "telegram_edit",
        description: "Edit the text of a previously sent message. Use 'last' to edit the most recent bot message.",
        parameters: Type.Object({
          message_id: Type.String({ description: "Message ID to edit, or 'last' for the most recent bot message" }),
          text: Type.String({ description: "New message text" }),
          parse_mode: Type.Optional(Type.String({ description: "Parse mode: MarkdownV2 or HTML (optional)" })),
        }),
        async execute(params: { message_id: string; text: string; parse_mode?: string }) {
          if (!state.botApi) {
            return { content: [{ type: "text" as const, text: "Bot API not available" }], isError: true };
          }
          const chatId = state.botApi.getChatId();
          if (!chatId) {
            return { content: [{ type: "text" as const, text: "No active chat" }], isError: true };
          }
          const msgId = params.message_id === "last" ? state.botApi.getLastMessageId() : parseInt(params.message_id);
          if (!msgId) {
            return { content: [{ type: "text" as const, text: "No message to edit" }], isError: true };
          }
          await state.botApi.editMessageText(chatId, msgId, params.text, params.parse_mode);
          return { content: [{ type: "text" as const, text: `Edited message ${msgId}` }] };
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
