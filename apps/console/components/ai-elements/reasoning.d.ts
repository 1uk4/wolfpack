import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { ComponentProps, ReactNode } from "react";
export declare const useReasoning: () => any;
export type ReasoningProps = ComponentProps<typeof Collapsible> & {
    isStreaming?: boolean;
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
};
export declare const Reasoning: any;
export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
    getThinkingMessage?: (isStreaming: boolean) => ReactNode;
};
export declare const ReasoningTrigger: any;
export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent> & {
    children: string;
};
export declare const ReasoningContent: any;
//# sourceMappingURL=reasoning.d.ts.map