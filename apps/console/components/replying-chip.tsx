/** The "Replying to: <question> ×" chip both composers (page and floating bar) show while their next text is bound to one question of a paged ask. */
export function ReplyingChip({ label, onClear, className }: { label: string; onClear?: () => void; className?: string }) {
	return (
		<div className={className}>
			<span data-testid="answering-chip" className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 font-ui text-xs">
				Replying to: {label}
				<button type="button" aria-label="Stop answering this question" data-testid="answering-chip-clear" onClick={onClear} className="rounded-full px-1 hover:bg-background">×</button>
			</span>
		</div>
	);
}
