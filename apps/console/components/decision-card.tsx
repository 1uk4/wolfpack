import { cn } from "@/lib/utils";
import { parseObjectData } from "@wolfpack/protocol/objects";
import type { ObjectCardProps } from "@/components/card-registry";
import { ObjectCardFrame } from "@/components/object-card";

/** A decision object: the options weighed (the chosen one highlighted) and the rationale. */
export function DecisionCard({ objectId, rev, data }: ObjectCardProps) {
	const d = parseObjectData("decision", data);
	if (!d) return null;
	return (
		<ObjectCardFrame testId="decision-card" objectId={objectId} rev={rev} label="Decision">
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
		</ObjectCardFrame>
	);
}
