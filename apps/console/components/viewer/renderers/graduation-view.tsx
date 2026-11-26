"use client";

import { useEffect, useState } from "react";
import { GraduationDetails } from "@/components/work/graduation-details";
import { fetchWolves, fetchWorkList, fetchWorkRecord } from "@/components/kb/kb-client";
import { useLibrarian } from "@/components/kb/use-librarian";
import { graduateState, resolveWork, workWolfCandidates } from "@/src/core";
import type { ViewRendererProps } from "../registry";

type Grad = { assignee?: string; ready: boolean; reason: string };

/** Kind "graduation": the "More details" of a graduation (id `<itemId>@<wolf>`) in the panel. The item's assignee/ready/reason are derived as on the work item page. */
export function GraduationViewRenderer({ descriptor, onTitle }: ViewRendererProps) {
	const at = descriptor.id.lastIndexOf("@");
	const itemId = descriptor.id.slice(0, at);
	const wolf = descriptor.id.slice(at + 1);
	const { librarian, loading } = useLibrarian();
	const [grad, setGrad] = useState<Grad | null>(null);
	useEffect(() => onTitle("Graduation details"), [onTitle]);
	useEffect(() => {
		if (loading) return;
		let cancelled = false;
		void (async () => {
			const w = await fetchWolves();
			const hit = await resolveWork(workWolfCandidates(librarian, w.ok ? w.data.wolves : []), itemId, fetchWorkRecord);
			let g: Grad = { ready: false, reason: "this item cannot be graduated" };
			if (hit.kind !== "none" && hit.result.ok && (hit.result.data.kind === "feature" || hit.result.data.kind === "initiative") && hit.result.data.domain) {
				const item = hit.result.data;
				const list = await fetchWorkList(hit.wolf, item.domain!, true, 30_000);
				const rows = list.ok ? list.data.items : null;
				const self = rows?.find((r) => r.id === item.id);
				const kids = rows ? rows.filter((r) => r.partOf === item.id).map((r) => ({ stage: r.stage, kind: r.kind, graduated: !!r.graduated })) : null;
				const gs = self ? graduateState({ kind: item.kind, stage: item.stage, graduated: !!self.graduated, standing: self.standing }, kids) : null;
				if (self && gs?.show) g = { ...(self.assignee ? { assignee: self.assignee } : {}), ready: gs.ready, reason: gs.reason };
			}
			if (!cancelled) setGrad(g);
		})();
		return () => {
			cancelled = true;
		};
	}, [librarian, loading, itemId]);
	return (
		<div className="p-4">
			{grad ? <GraduationDetails itemId={itemId} wolf={wolf} assignee={grad.assignee} ready={grad.ready} reason={grad.reason} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
		</div>
	);
}
