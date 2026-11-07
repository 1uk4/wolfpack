import { createContext } from "react";

/**
 * What a job card may ask of the chat it sits in: pull fresh messages once a background job settles (the wake turn's
 * steer and response are already persisted by then), send a user message into the session, or open the model setup
 * dialog. Null outside a chat. (contracts.ts "THE ASYNC PROTOCOL" §4.)
 */
export const ChatActionsContext = createContext<{
	chatId: string;
	syncFromServer: () => Promise<void>;
	/** Send a user message into the session. */
	sendText: (text: string) => void;
	/** Opens the model setup dialog (BYOK, 2026-09-22): refused job cards deep-link into the same SetupDialog. */
	openSetup: () => void;
} | null>(null);
