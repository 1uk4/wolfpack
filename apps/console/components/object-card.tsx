import type { ReactNode } from "react";

/** "updated 1 time" / "updated N times" — rev 1 is the first showing, so a card at rev r was revised r−1 times. */
export function updatedMarker(rev: number): string | undefined {
	const n = rev - 1;
	return n < 1 ? undefined : `updated ${n} ${n === 1 ? "time" : "times"}`;
}

/** Shared frame of every object card: the type label, optional extras, and the "updated N times" marker. */
export function ObjectCardFrame({
	testId,
	objectId,
	rev,
	label,
	extra,
	children,
}: {
	testId: string;
	objectId: string;
	rev: number;
	label: string;
	extra?: ReactNode;
	children: ReactNode;
}) {
	const marker = updatedMarker(rev);
	return (
		<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid={testId} data-object-id={objectId} data-rev={rev}>
			<div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				<span>{label}</span>
				{extra}
				{marker && (
					<span data-testid="object-updated" className="rounded-full border px-2 py-0.5 normal-case tracking-normal">
						{marker}
					</span>
				)}
			</div>
			{children}
		</div>
	);
}
