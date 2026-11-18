"use client";

import type { ComponentProps, ReactNode } from "react";
import { StickToBottom } from "use-stick-to-bottom";
import { cn } from "@/lib/utils";

// Scroll container that follows the bottom while content streams in.
export function Conversation({ className, ...props }: ComponentProps<typeof StickToBottom>) {
	return (
		<StickToBottom
			className={cn("relative flex-1 overflow-y-hidden", className)}
			initial="smooth"
			resize="smooth"
			role="log"
			{...props}
		/>
	);
}

export function ConversationContent({ className, ...props }: ComponentProps<typeof StickToBottom.Content>) {
	return <StickToBottom.Content className={cn("flex flex-col gap-8 p-4", className)} {...props} />;
}

export function ConversationEmptyState({
	className,
	title = "No messages yet",
	description = "Start a conversation to see messages here",
	icon,
	children,
	...props
}: ComponentProps<"div"> & { title?: string; description?: string; icon?: ReactNode }) {
	return (
		<div
			className={cn("flex size-full flex-col items-center justify-center gap-3 p-8 text-center", className)}
			{...props}
		>
			{children ?? (
				<>
					{icon && <div className="text-muted-foreground">{icon}</div>}
					<div className="space-y-1">
						<h3 className="text-sm font-medium">{title}</h3>
						{description && <p className="text-sm text-muted-foreground">{description}</p>}
					</div>
				</>
			)}
		</div>
	);
}
