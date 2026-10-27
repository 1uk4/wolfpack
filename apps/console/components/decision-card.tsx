import { cn } from "@/lib/utils";
import { parseObjectData } from "@wolfpack/protocol/objects";
import type { ObjectCardProps } from "@/components/card-registry";

/** "updated 1 time" / "updated N times" — rev 1 is the first showing, so a card at rev r was revised r−1 times. */
export function updatedMarker(rev: number): string | undefined {
	const n = rev - 1;
	return n < 1 ? undefined : `updated ${n} ${n === 1 ? "time" : "times"}`;
}

/** A decision object: the options weighed (the chosen one highlighted) and the rationale. */
export function DecisionCard({ objectId, rev, data }: ObjectCardProps) {
	const d = parseObjectData("decision", data);
	if (!d) return null;
	const marker = updatedMarker(rev);
	return (
		<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="decision-card" data-object-id={objectId} data-rev={rev}>
			<div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				<span>Decision</span>
				{marker && (
					<span data-testid="object-updated" className="rounded-full border px-2 py-0.5 normal-case tracking-normal">
						{marker}
					</span>
				)}
			</div>
			{d.title && <div className="mb-2 text-sm font-medium">{d.title}</div>}
			<ul className="flex flex-col gap-1.5">
				{d.options.map((o) => {
					const chosen = o.id === d.chosen;
					return (
						<li
							key={o.id}
							data-testid="decision-option"
							data-chosen={chosen ? "true" : "false"}
							className={cn("rounded-lg border px-3 py-2 text-sm", chosen ? "border-primary bg-primary/10" : "text-muted-foreground")}
						>
							<div className="flex items-center gap-2">
								<span className={cn(chosen && "font-medium text-foreground")}>{o.label}</span>
								{chosen && <span className="text-xs uppercase tracking-wide text-primary">Chosen</span>}
							</div>
							{o.detail && <div className="text-xs text-muted-foreground">{o.detail}</div>}
						</li>
					);
				})}
			</ul>
			<p data-testid="decision-rationale" className="mt-3 whitespace-pre-wrap text-sm">
				{d.rationale}
			</p>
		</div>
	);
}
