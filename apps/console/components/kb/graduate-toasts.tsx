"use client";

import { graduateStore, useGraduateDone } from "./graduate-store";
import { ZC } from "@/lib/z-layers";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a finished graduation did. Mounted once (next to the Work view provider); the KB itself follows the librarian's sweep. */
export function GraduateToasts() {
	const done = useGraduateDone();
	if (done.length === 0) return null;
	return (
		<div className={`pointer-events-none fixed bottom-4 right-4 ${ZC.toast} flex flex-col gap-2`} data-testid="graduate-toasts">
			{done.map((d) => (
				<div key={d.id} role="status" data-testid="graduate-done" data-work={d.id} className="pointer-events-auto flex max-w-sm items-start gap-3 rounded-lg border border-emerald-400/40 bg-card px-3 py-2 text-xs shadow-lg">
					{d.awaitingApproval ? (
						<div data-testid="graduate-filed">
							<div className="font-medium">“{d.title}”: request filed</div>
							<div className="mt-0.5 text-muted-foreground">Approve it on an owner device (Needs-you). Nothing is sent or archived until then.</div>
						</div>
					) : (
						<div>
							<div className="font-medium">
								“{d.title}” graduated: {plural(d.result.entries.length, "contribution")} sent to the librarian
							</div>
							<div className="mt-0.5 text-muted-foreground">New KB entries appear after the librarian’s next sweep.</div>
						</div>
					)}
					<button type="button" data-testid="graduate-done-dismiss" aria-label="Dismiss" onClick={() => graduateStore.dismissDone(d.id)} className="text-muted-foreground hover:text-foreground">
						×
					</button>
				</div>
			))}
		</div>
	);
}
