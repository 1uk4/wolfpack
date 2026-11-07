"use client";

import { BrailleSpinner } from "@/components/braille-spinner";
import { ContextBar, compactionDetail, formatTokens, pastStartAt, useThreadContext } from "@/components/thread-context";
import { Button } from "@/components/ui/button";

/** The Memory panel's Context row: label, thin fill bar and Compact button on one line (live context for the thread). */
export function ContextSection({ wolf, slug, threadId }: { wolf: string; slug: string; threadId: string }) {
	const { ctx, compacting, error, compact } = useThreadContext(wolf, slug, threadId);
	if (!ctx) return null;
	const detail = compactionDetail(ctx);
	return (
		<section data-testid="context-section" title="Thread context">
			<div className="flex items-center gap-2">
				<span className={`shrink-0 font-mono text-xs ${pastStartAt(ctx) ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`} data-testid="context-section-label">
					{ctx.window ? `${formatTokens(ctx.tokens)} / ${formatTokens(ctx.window)}` : formatTokens(ctx.tokens)}
				</span>
				<div className="min-w-8 flex-1"><ContextBar c={ctx} /></div>
				<Button size="xs" variant="ghost" data-testid="context-compact" disabled={compacting} onClick={() => void compact()}>
					Compact
				</Button>
			</div>
			{compacting || detail ? (
				<p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground" data-testid="context-section-detail">
					{compacting ? (
						<>
							<BrailleSpinner label="Summarising" className="h-3" />
							Summarising…
						</>
					) : (
						detail
					)}
				</p>
			) : null}
			{error ? <p role="alert" className="text-xs text-destructive" data-testid="context-error">{error}</p> : null}
		</section>
	);
}
