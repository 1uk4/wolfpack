/**
 * Shared state for telegram extension/client coordination.
 * Created once by harness, passed to both extension and client.
 */
import type { TelegramSharedState, TelegramButton, ReplyKeyboard, TelegramAttachment } from "../extension-api.js";
export type { TelegramSharedState, TelegramButton, ReplyKeyboard, TelegramAttachment };
export declare const VALID_REACTIONS: Set<string>;
/**
 * Create shared state for telegram extension/client coordination.
 * Both extension tools and telegram client read/write to this state.
 */
export declare function createTelegramSharedState(): TelegramSharedState;
//# sourceMappingURL=shared-state.d.ts.map