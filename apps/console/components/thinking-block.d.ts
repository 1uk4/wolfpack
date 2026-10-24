export declare function currentUserThinkingOpen(): boolean;
export declare function setAllUserThinkingOpen(open: boolean): void;
export declare function ThinkingBlock({ label, text, testId, dataCommit, defaultOpen, inCard, }: {
    label?: string;
    text: string;
    testId?: string;
    /** The practice marker's register flag (commit vs nudge). */
    dataCommit?: boolean;
    /** Transcript rows arrive expanded (owner, 2026-10-07). */
    defaultOpen?: boolean;
    /** On the card's own background: no band (the accent read too light). */
    inCard?: boolean;
}): any;
//# sourceMappingURL=thinking-block.d.ts.map