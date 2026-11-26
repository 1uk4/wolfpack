"use client";

/**
 * Update notice in the sidebar footer (above Settings) (work-wolfpack-vkAgw7I). Reads GET /api/updates once on load and then hourly and
 * shows a small card per machine that is behind or has a failed update: "sfo-01: hubd 0.1.23 is available" (several on one machine:
 * "sfo-01: 2 updates available" with their names), a failed one reads "Update failed on sfo-01". The raw updateStatus state, repo paths and
 * the server's manual/stale/step text are never shown here. "Update now" opens Pack > Machines with `?update=<machine>:<components>`; the
 * machine card starts the update on arrival (components/pack/pack-machines.tsx). The × hides the notice for the versions shown; a newer
 * version brings it back (dismissed keys `<component>@<latest>` in localStorage).
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpCircleIcon, XIcon } from "lucide-react";

type Row = { component: string; running: string | null; latest: string | null; outdated: boolean | null; notesUrl: string | null; updateStep?: string; updateStatus?: { state: string; host?: string } };

const HOUR = 60 * 60_000;
const STORE = "wolfpack.update-notice.dismissed";

type Group = { machine: string; items: { component: string; latest: string | null; key: string }[]; failed: boolean; notesUrl: string | null };

const keyOf = (r: Row) => `${r.component}@${r.latest ?? "?"}`;

function groupRows(rows: Row[], dismissed: ReadonlySet<string>): Group[] {
	const by = new Map<string, Group>();
	for (const r of rows) {
		if (dismissed.has(keyOf(r))) continue;
		const failed = r.updateStatus?.state === "failed";
		if (r.outdated !== true && !failed) continue;
		const machine = r.updateStatus?.host || "this machine";
		const g = by.get(machine) ?? { machine, items: [], failed: false, notesUrl: null };
		g.items.push({ component: r.component, latest: r.latest, key: keyOf(r) });
		g.failed ||= failed;
		g.notesUrl ??= r.notesUrl;
		by.set(machine, g);
	}
	return [...by.values()];
}

export const updateHref = (g: Pick<Group, "machine" | "items">) => `/pack/machines?update=${encodeURIComponent(`${g.machine}:${g.items.map((i) => i.component).join(",")}`)}`;

function title(g: Group): string {
	if (g.failed) return `Update failed on ${g.machine}`;
	if (g.items.length > 1) return `${g.machine}: ${g.items.length} updates available`;
	const i = g.items[0]!;
	return `${g.machine}: ${i.component}${i.latest ? ` ${i.latest}` : ""} is available`;
}

export function UpdateNoticeView({ rows, dismissed, onDismiss }: { rows: Row[]; dismissed: ReadonlySet<string>; onDismiss: (keys: string[]) => void }) {
	const groups = groupRows(rows, dismissed);
	if (!groups.length) return null;
	return (
		<div data-testid="update-notice" className="mb-1 flex flex-col gap-1.5">
			{groups.map((g) => (
				<div key={g.machine} className="relative rounded-md border border-teal-500/30 bg-teal-500/5 px-2.5 py-2 text-xs">
					<button type="button" aria-label="Dismiss" onClick={() => onDismiss(g.items.map((i) => i.key))} className="absolute right-1 top-1 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
						<XIcon className="size-3" />
					</button>
					<div className="flex items-start gap-1.5 pr-4 text-foreground">
						<ArrowUpCircleIcon className={`mt-0.5 size-3 shrink-0 ${g.failed ? "text-red-400" : "text-teal-400"}`} />
						<span>{title(g)}</span>
					</div>
					{g.items.length > 1 && !g.failed && <div className="mt-0.5 pl-[18px] text-muted-foreground">{g.items.map((i) => `${i.component}${i.latest ? ` ${i.latest}` : ""}`).join(", ")}</div>}
					<div className="mt-1.5 flex items-center gap-3 pl-[18px]">
						<Link href={updateHref(g)} className="rounded-sm border border-teal-500/40 bg-teal-500/15 px-2 py-0.5 font-medium text-teal-300 hover:bg-teal-500/25">
							Update now
						</Link>
						{g.notesUrl && (
							<a href={g.notesUrl} target="_blank" rel="noreferrer" className="text-muted-foreground underline hover:text-foreground">
								What's new
							</a>
						)}
					</div>
				</div>
			))}
		</div>
	);
}

function readDismissed(): Set<string> {
	try {
		const v = JSON.parse(localStorage.getItem(STORE) ?? "[]") as unknown;
		return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
	} catch {
		return new Set();
	}
}

export function UpdateNotice() {
	const [rows, setRows] = useState<Row[]>([]);
	const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
	useEffect(() => setDismissed(readDismissed()), []);
	useEffect(() => {
		let alive = true;
		const load = () =>
			void fetch("/api/updates")
				.then((r) => (r.ok ? (r.json() as Promise<{ components?: Row[] }>) : null))
				.then((b) => alive && setRows(b?.components ?? []))
				.catch(() => {});
		load();
		const t = setInterval(load, HOUR);
		return () => {
			alive = false;
			clearInterval(t);
		};
	}, []);
	const dismiss = (keys: string[]) => {
		const next = new Set([...dismissed, ...keys]);
		setDismissed(next);
		try {
			localStorage.setItem(STORE, JSON.stringify([...next]));
		} catch {
			/* storage unavailable: hidden for this page view only */
		}
	};
	return <UpdateNoticeView rows={rows} dismissed={dismissed} onDismiss={dismiss} />;
}
