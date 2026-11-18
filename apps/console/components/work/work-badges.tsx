/** A work item's kind, stage and domain as small pills (work item page, memory panel). */
export function WorkBadges({ kind, stage, domain, className = "" }: { kind?: string; stage?: string; domain?: string; className?: string }) {
	const facts = [
		["kind", kind],
		["stage", stage?.replace(/_/g, " ")],
		["domain", domain],
	].filter((f): f is [string, string] => Boolean(f[1]));
	if (facts.length === 0) return null;
	return (
		<div className={`flex flex-wrap gap-1.5 ${className}`} data-testid="work-badges">
			{facts.map(([name, value]) => (
				<span
					key={name}
					data-fact={name}
					title={name}
					className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
				>
					{value}
				</span>
			))}
		</div>
	);
}
