import type { LhMessage } from "@/src/core";
export interface UseChatSessionOptions {
    chatId: string;
    /** The native record seed (server-rendered page or a full sync). */
    initialMessages: LhMessage[];
    /** Reattach on mount: a turn is running server-side with no live view. */
    initiallyInFlight?: boolean;
}
export declare function useChatSession({ chatId, initialMessages, initiallyInFlight }: UseChatSessionOptions): {
    messages: any;
    nativeMessages: any;
    status: any;
    error: any;
    steerQueue: any;
    send: any;
    steer: any;
    submitAnswer: any;
    dismissQuestion: any;
    dismissProblem: any;
    setMessages: any;
    adoptRecord: any;
    stop: any;
    clearError: any;
    resumeStream: any;
    setReattachSettled: any;
};
//# sourceMappingURL=session.d.ts.map