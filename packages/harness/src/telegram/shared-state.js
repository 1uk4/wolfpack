/**
 * Shared state for telegram extension/client coordination.
 * Created once by harness, passed to both extension and client.
 */
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
export function createTelegramSharedState() {
    return {
        queuedButtons: new Map(),
        queuedReplyKeyboards: new Map(),
        queuedReactions: new Map(),
        queuedAttachments: new Map(),
        validReactions: VALID_REACTIONS,
    };
}
//# sourceMappingURL=shared-state.js.map