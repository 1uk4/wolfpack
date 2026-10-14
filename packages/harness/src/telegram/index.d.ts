/**
 * Telegram client for Pi Durable harness.
 *
 * Unlike the pi-coding-agent extension which hooks into agent lifecycle,
 * this is a client that:
 * 1. Receives messages via grammY bot
 * 2. Submits them to the harness via conversation.submit()
 * 3. Watches events via watchEvents() to stream responses back
 * 4. Sends queued attachments after the turn completes
 */
import type { Harness } from "@earendil-works/pi-durable";
import { type TelegramSharedState } from "./shared-state.js";
export { createTelegramSharedState, VALID_REACTIONS, type TelegramSharedState, type TelegramButton, type ReplyKeyboard } from "./shared-state.js";
export interface TelegramClientConfig {
    botToken: string;
    ownerId: number;
    tempDir?: string;
    /** Shared state for extension coordination. If not provided, creates internal state. */
    sharedState?: TelegramSharedState;
}
export interface TelegramClient {
    start(): Promise<void>;
    stop(): Promise<void>;
}
export declare function createTelegramClient(harness: Harness, config: TelegramClientConfig): Promise<TelegramClient>;
//# sourceMappingURL=index.d.ts.map