"use client";

import { useState } from "react";
import { InlineMarkdown } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import type { CardBrief } from "@wolfpack/client";

/** Bullets longer than this are clamped to two lines behind a "more" toggle (a soft limit: the schema never rejects them). */
export const BULLET_SOFT_CHARS = 160;

function Bullet({ text }: { text: string }) {
	const long = text.length > BULLET_SOFT_CHARS;
	const [open, setOpen] = useState(false);
	const clamped = long && !open;
	return (
		<li className="flex gap-2" data-testid="brief-bullet" data-clamped={clamped || undefined}>
			<span aria-hidden className="text-muted-foreground">
				•
			</span>
			<span className="min-w-0 flex-1">
				<InlineMarkdown className={cn(clamped && "line-clamp-2")}>{text}</InlineMarkdown>
				{long && (
					<button type="button" className="ml-1 text-xs text-muted-foreground underline" data-testid="brief-bullet-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
						{open ? "less" : "more"}
					</button>
				)}
			</span>
		</li>
	);
}

/**
 * The header of a brief card: headline, a few context bullets, and a pointer to the thread. Self-contained (no card
 * state), so the floating chat bar renders the same header. `onOpenThread` is what "Open thread for more" does.
 */
export function BriefHeader({ brief, onOpenThread, compact, className }: { brief: CardBrief; onOpenThread?: () => void; compact?: boolean; className?: string }) {
	return (
		<div className={cn("flex flex-col gap-1.5", className)} data-testid="brief-header">
			<div className={cn("font-semibold", compact ? "text-sm" : "text-base")} data-testid="brief-headline">
				<InlineMarkdown>{brief.headline}</InlineMarkdown>
			</div>
			{brief.context && brief.context.length > 0 && (
				<ul className={cn("flex flex-col gap-1 text-muted-foreground", compact ? "text-xs" : "text-sm")} data-testid="brief-context">
					{brief.context.map((b, i) => (
						<Bullet key={i} text={b} />
					))}
				</ul>
			)}
			{brief.more !== undefined && (
				<button type="button" className="self-start text-xs text-primary underline" data-testid="brief-more" title={brief.more} onClick={onOpenThread}>
					Open thread for more
				</button>
			)}
		</div>
	);
}
