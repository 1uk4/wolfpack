/**
 * Shared state for telegram extension/client coordination.
 * Created once by harness, passed to both extension and client.
 */

import type { TelegramSharedState, TelegramButton, ReplyKeyboard, TelegramAttachment } from "../extension-api.js";

export type { TelegramSharedState, TelegramButton, ReplyKeyboard, TelegramAttachment };

// Telegram-allowed reaction emojis (from official docs)
export const VALID_REACTIONS = new Set([
  "❤", "👍", "👎", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩",
  "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭",
  "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈",
  "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗",
  "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊",
  "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡"
]);

/**
 * Create shared state for telegram extension/client coordination.
 * Both extension tools and telegram client read/write to this state.
 */
export function createTelegramSharedState(): TelegramSharedState {
  return {
    queuedButtons: new Map<string, TelegramButton[][]>(),
    queuedReplyKeyboards: new Map<string, ReplyKeyboard>(),
    queuedReactions: new Map<string, string>(),
    queuedAttachments: new Map<string, TelegramAttachment[]>(),
    validReactions: VALID_REACTIONS,
  };
}
