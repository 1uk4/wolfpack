import { type ArtifactPartProps } from "@/src/core";
/** The practice-thinking marker's details (native-messages.ts). */
export interface PracticeThinkingData {
    problemCallId: string;
    /** Legacy records (pre 2026-10-05) carry the old two-lane flag; ignored. */
    commit?: boolean;
    text: string;
}
export declare function ProblemCard({ part }: ArtifactPartProps): any;
export declare function ConcludeCard({ part }: ArtifactPartProps): any;
export declare function ThinkingCard({ data }: {
    data: PracticeThinkingData;
}): any;
//# sourceMappingURL=practice-cards.d.ts.map