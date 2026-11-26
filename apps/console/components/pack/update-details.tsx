"use client";

/**
 * "Update details" (work-wolfpack-B8vtRi3): a collapsed disclosure under each update item (the Mac app, this console's machine, another
 * machine) for the power user. It reads out what the UpdateState already carries (channel, current → latest, last check, auto-update) plus
 * the feed, a Logs button and Roll back. The controls that already sit on the card (channel picker, Check now, auto switch) are not repeated.
 */
import type { UpdateState } from "@wolfpack/protocol/update-state";
import { ageText } from "@/src/core";

const LINK = "rounded-sm border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50 max-md:min-h-11 max-md:px-3";

/** A short label for where updates come from; a custom feed shows its host only, never the path or query. */
export function feedLabel(target: "app" | "pack", channel: "stable" | "main" | null, customUrl?: string | null): string {
	if (customUrl) {
		try {
			return `Custom feed (${new URL(customUrl).host})`;
		} catch {
			return "Custom feed";
		}
	}
	const c = channel ? ` (${channel})` : ""; // an unknown channel is not guessed
	return target === "app" ? `GitHub releases${c}` : `Pack manifest${c}`;
}

export type RollbackProp = { offered: { service: string; to: string }[]; onRollback: (service: string) => void; busy?: boolean; note?: string | null } | { remoteText: string };

/** The services whose journal logs.fetch may read; the update unit itself is not on that list, so Logs shows the component's own log. */
export const LOGGABLE = new Set("console hubd workerd".split(" "));

export type DetailsLog = "loading" | { lines: string[]; error: string | null };

export function UpdateDetails({ state, feed, now, onLogs, log, rollback }: { state: UpdateState | null | undefined; feed: string | null; now?: number; onLogs?: () => void; /** What the Logs button fetched, shown under it. */ log?: DetailsLog; rollback?: RollbackProp }) {
	const at = state?.lastCheck ? Date.parse(state.lastCheck) : NaN;
	const last = Number.isNaN(at) ? "never" : ageText(Math.max(0, (now ?? Date.now()) - at));
	const versions = state?.current ? `${state.current} → ${state.latest ?? "up to date"}` : state?.latest ? `unknown → ${state.latest}` : "unknown";
	const rows: [string, string][] = [
		["Channel", state?.channel ?? "unknown"],
		["Version", versions],
		["Last check", last],
		["Auto-update", state?.auto ?? "unknown"],
	];
	if (feed) rows.push(["Feed", feed]);
	return (
		<details data-testid="update-details" className="mt-2 text-muted-foreground">
			<summary className="cursor-pointer select-none max-md:min-h-11">Update details</summary>
			<dl className="mt-1 space-y-0.5">
				{rows.map(([k, v]) => (
					<div key={k} className="flex gap-1.5">
						<dt>{k}:</dt>
						<dd className="text-foreground">{v}</dd>
					</div>
				))}
			</dl>
			<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
				{onLogs && <button type="button" data-testid="update-logs" onClick={onLogs} className={LINK}>Logs</button>}
				{rollback && "remoteText" in rollback && <p data-testid="update-rollback-remote">{rollback.remoteText}</p>}
				{rollback && "offered" in rollback && rollback.offered.map((o) => <button key={o.service} type="button" data-testid={`update-rollback-${o.service}`} disabled={rollback.busy} onClick={() => rollback.onRollback(o.service)} className={LINK}>Roll back {o.service} to {o.to}</button>)}
				{rollback && "note" in rollback && rollback.note && <p data-testid="update-rollback-note">{rollback.note}</p>}
			</div>
			{log === "loading" && <p data-testid="update-log">Loading…</p>}
			{log && log !== "loading" && (log.error ? <p data-testid="update-log">{log.error}</p> : <pre data-testid="update-log" className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-sm border px-2 py-1 text-xs">{log.lines.join("\n")}</pre>)}
		</details>
	);
}
