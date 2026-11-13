import { CornerDownRightIcon, XIcon } from "lucide-react";

/** The "Replying to: <question> ×" chip both composers (page and floating bar) show while their next text is bound to one question of a paged ask. */
export function ReplyingChip({ label, onClear, className }: { label: string; onClear?: () => void; className?: string }) {
	return (
		<div className={className}>
			<span data-testid="answering-chip" className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-(color:--thread-accent)/40 bg-accent py-0.5 pl-2 pr-1 font-ui text-xs text-foreground">
				<CornerDownRightIcon aria-hidden className="size-3 shrink-0 text-(color:--thread-accent)" />
				<span className="min-w-0 truncate">Replying to: {label}</span>
				<button type="button" aria-label="Stop answering this question" data-testid="answering-chip-clear" onClick={onClear} className="flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
					<XIcon aria-hidden className="size-3" />
				</button>
			</span>
		</div>
	);
}
