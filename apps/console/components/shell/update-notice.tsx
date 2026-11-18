"use client";

/**
 * "Update available" note in the sidebar footer (above Settings). Reads GET /api/updates once on load and then hourly; renders
 * nothing unless a component is known to be behind the latest stable release, has a failed auto-update, or the host's updater is
 * stale (`updateStatus.stale`: no check for two timer intervals), which shows as one grey line. Each outdated component links to
 * its release notes and names its update step; nothing is applied from here (the automatic update is work-wolfpack-qrU6cCO, the
 * full health panel work-wolfpack-6imFEq7).
 */
import { useEffect, useState } from "react";
import { ArrowUpCircleIcon } from "lucide-react";
import { updateWarnings } from "@/src/core";

type Row = { component: string; running: string | null; latest: string | null; outdated: boolean | null; notesUrl: string | null; updateStep: string; updateStatus?: { state: string; code?: string; host?: string; lastCheck?: string; stale?: boolean; manual?: boolean } };

const HOUR = 60 * 60_000;

export function UpdateNotice() {
	const [rows, setRows] = useState<Row[]>([]);
	const [warnings, setWarnings] = useState<string[]>([]);
	const [open, setOpen] = useState(false);
	useEffect(() => {
		let alive = true;
		const load = () =>
			void fetch("/api/updates")
				.then((r) => (r.ok ? (r.json() as Promise<{ components?: Row[] }>) : null))
				.then((b) => {
					if (!alive) return;
					const all = b?.components ?? [];
					setRows(all.filter((c) => c.outdated === true || c.updateStatus?.state === "failed"));
					setWarnings(updateWarnings(all, Date.now()));
				})
				.catch(() => {});
		load();
		const t = setInterval(load, HOUR);
		return () => {
			alive = false;
			clearInterval(t);
		};
	}, []);
	if (!rows.length && !warnings.length) return null;
	return (
		<div data-testid="update-notice">
			{rows.length > 0 && (
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen((o) => !o)}
					className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-amber-400 transition-colors hover:bg-accent"
				>
					<ArrowUpCircleIcon className="size-3" />
					Update available
				</button>
			)}
			{warnings.map((w) => (
				<div key={w} data-testid="update-stale" className="px-2 pb-1.5 text-xs text-muted-foreground">
					{w}
				</div>
			))}
			{open && rows.length > 0 && (
				<ul className="flex flex-col gap-1.5 px-2 pb-1.5 text-xs normal-case text-muted-foreground">
					{rows.map((r) => (
						<li key={r.component}>
							<span className="text-foreground">{r.component}</span> {r.running} → {r.latest}
							{r.updateStatus && r.updateStatus.state !== "idle" && (
								<span className={r.updateStatus.state === "failed" ? "text-red-400" : ""}>
									{" "}
									[{r.updateStatus.state}
									{r.updateStatus.code ? `: ${r.updateStatus.code}` : ""}]
								</span>
							)}
							{r.notesUrl && (
								<>
									{" "}
									<a href={r.notesUrl} target="_blank" rel="noreferrer" className="underline hover:text-foreground">
										release notes
									</a>
								</>
							)}
							<div>{r.updateStep}</div>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
