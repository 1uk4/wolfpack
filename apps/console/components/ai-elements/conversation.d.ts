import { Button } from "@/components/ui/button";
import type { LhViewMessage } from "@/src/core";
import type { ComponentProps } from "react";
import { StickToBottom } from "use-stick-to-bottom";
export type ConversationProps = ComponentProps<typeof StickToBottom>;
export declare const Conversation: ({ className, ...props }: ConversationProps) => any;
export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;
export declare const ConversationContent: ({ className, ...props }: ConversationContentProps) => any;
export type ConversationEmptyStateProps = ComponentProps<"div"> & {
    title?: string;
    description?: string;
    icon?: React.ReactNode;
};
export declare const ConversationEmptyState: ({ className, title, description, icon, children, ...props }: ConversationEmptyStateProps) => any;
export type ConversationScrollButtonProps = ComponentProps<typeof Button>;
export declare const ConversationScrollButton: ({ className, ...props }: ConversationScrollButtonProps) => any;
export type ConversationDownloadProps = Omit<ComponentProps<typeof Button>, "onClick"> & {
    messages: LhViewMessage[];
    filename?: string;
    formatMessage?: (message: LhViewMessage, index: number) => string;
};
export declare const messagesToMarkdown: (messages: LhViewMessage[], formatMessage?: (message: LhViewMessage, index: number) => string) => string;
export declare const ConversationDownload: ({ messages, filename, formatMessage, className, children, ...props }: ConversationDownloadProps) => any;
//# sourceMappingURL=conversation.d.ts.map