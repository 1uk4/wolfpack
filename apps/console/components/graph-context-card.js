"use client";
import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
export function GraphContextCard({ data }) {
    const [open, setOpen] = useState(false);
    const { propositions = [], chains = [] } = data ?? {};
    const noun = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    return (<div data-testid="graph-context-card" className="my-1">
			<button type="button" data-testid="graph-context-toggle" onClick={() => setOpen((v) => !v)} className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
				<ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}/>
				<span className="font-medium">Graph context</span>
				<span className="min-w-0 flex-1 truncate">
					{noun(propositions.length, "proposition", "propositions")}
					{chains.length > 0 ? ` · ${noun(chains.length, "chain", "chains")}` : ""}
				</span>
			</button>
			{open && (<div data-testid="graph-context-body" className="mt-1 space-y-1 rounded-lg border border-dashed border-border/70 px-4 py-3 text-xs">
					{propositions.map((p) => (<div key={p.id} data-testid={`graph-context-prop-${p.id}`} className="leading-relaxed">
							<span className="font-medium text-foreground/80">{p.name}</span>
							<span className="text-muted-foreground"> — {p.statement}</span>
						</div>))}
					{chains.length > 0 && (<div className="pt-1">
							{chains.map((c, i) => (<div key={i} className="font-mono text-[11px] text-muted-foreground">
									{c}
								</div>))}
						</div>)}
				</div>)}
		</div>);
}
//# sourceMappingURL=graph-context-card.js.map