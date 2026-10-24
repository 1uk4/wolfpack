import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import type { ComponentProps, HTMLAttributes } from "react";
import type { LhViewMessage } from "@/src/core";
import { Streamdown, type PluginConfig } from "streamdown";
export type MessageProps = HTMLAttributes<HTMLDivElement> & {
    from: LhViewMessage["role"];
};
export declare const Message: ({ className, from, ...props }: MessageProps) => any;
export type MessageContentProps = HTMLAttributes<HTMLDivElement>;
export declare const MessageContent: ({ children, className, ...props }: MessageContentProps) => any;
export type MessageActionsProps = ComponentProps<"div">;
export declare const MessageActions: ({ className, children, ...props }: MessageActionsProps) => any;
export type MessageActionProps = ComponentProps<typeof Button> & {
    tooltip?: string;
    label?: string;
};
export declare const MessageAction: ({ tooltip, children, label, variant, size, ...props }: MessageActionProps) => any;
export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
    defaultBranch?: number;
    onBranchChange?: (branchIndex: number) => void;
};
export declare const MessageBranch: ({ defaultBranch, onBranchChange, className, ...props }: MessageBranchProps) => any;
export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;
export declare const MessageBranchContent: ({ children, ...props }: MessageBranchContentProps) => any;
export type MessageBranchSelectorProps = ComponentProps<typeof ButtonGroup>;
export declare const MessageBranchSelector: ({ className, ...props }: MessageBranchSelectorProps) => any;
export type MessageBranchPreviousProps = ComponentProps<typeof Button>;
export declare const MessageBranchPrevious: ({ children, ...props }: MessageBranchPreviousProps) => any;
export type MessageBranchNextProps = ComponentProps<typeof Button>;
export declare const MessageBranchNext: ({ children, ...props }: MessageBranchNextProps) => any;
export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;
export declare const MessageBranchPage: ({ className, ...props }: MessageBranchPageProps) => any;
export type MessageResponseProps = ComponentProps<typeof Streamdown>;
export declare const streamdownPlugins: PluginConfig;
export declare const MessageResponse: any;
export type MessageToolbarProps = ComponentProps<"div">;
export declare const MessageToolbar: ({ className, children, ...props }: MessageToolbarProps) => any;
//# sourceMappingURL=message.d.ts.map