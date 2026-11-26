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
import { failedLine, retryLabel, stageLabel, type UpdateState } from "@wolfpack/protocol/update-state";
import { useAppBridge } from "@/components/settings/app-bridge";
import { useAppUpdateState } from "@/components/settings/use-app-update-state";
import { updateOutcome } from "@/src/core";

type Row = { component: string; running: string | null; latest: string | null; outdated: boolean | null; notesUrl: string | null; updateStep?: string; updateStatus?: { state: string; host?: string }; updateState?: { state: string; progress?: number | null; error?: { message: string } } };

const HOUR = 60 * 60_000;
const STORE = "wolfpack.update-notice.dismissed";

type Group = { machine: string; reason: string | null; items: { component: string; latest: string | null; key: string }[]; failed: boolean; installing: boolean; notesUrl: string | null };

const keyOf = (r: Row) => `${r.component}@${r.latest ?? "?"}`;

function groupRows(rows: Row[], dismissed: ReadonlySet<string>): Group[] {
	const by = new Map<string, Group>();
	for (const r of rows) {
		if (dismissed.has(keyOf(r))) continue;
		const failed = r.updateStatus?.state === "failed";
		const installing = r.updateState?.state === "installing";
		if (r.outdated !== true && !failed && !installing) continue;
		const machine = r.updateStatus?.host || "this machine";
		const g = by.get(machine) ?? { machine, reason: null, items: [], failed: false, installing: false, notesUrl: null };
		g.installing ||= installing;
		g.items.push({ component: r.component, latest: r.latest, key: keyOf(r) });
		g.failed ||= failed;
		if (failed) g.reason ??= r.updateState?.error?.message ?? null;
		g.notesUrl ??= r.notesUrl;
		by.set(machine, g);
	}
	return [...by.values()];
}

export const updateHref = (g: Pick<Group, "machine" | "items">) => `/pack/machines?update=${encodeURIComponent(`${g.machine}:${g.items.map((i) => i.component).join(",")}`)}`;

function title(g: Group): string {
	if (g.failed) return `${g.machine}: ${failedLine({ error: g.reason ? { code: "", message: g.reason, retryable: false } : undefined })}`;
	if (g.installing) return `${g.machine}: ${stageLabel({ state: "installing", progress: null })}`;
	if (g.items.length > 1) return `${g.machine}: ${g.items.length} updates available`;
	const i = g.items[0]!;
	return `${g.machine}: ${i.component}${i.latest ? ` ${i.latest}` : ""} is available`;
}

/** The Mac app's own stage: shown while downloading, ready, installing or failed; idle/checking/updated stay quiet in the sidebar. */
function AppRow({ app, onInstall, onRetry }: { app: UpdateState; onInstall?: () => void; onRetry?: () => void }) {
	const failed = app.state === "failed";
	return (
		<div data-testid="update-notice-app" className="rounded-md border border-teal-500/30 bg-teal-500/5 px-2.5 py-2 text-xs">
			<div className="flex items-start gap-1.5 text-foreground">
				<ArrowUpCircleIcon className={`mt-0.5 size-3 shrink-0 ${failed ? "text-red-400" : "text-teal-400"}`} />
				<span>{failed ? failedLine(app) : stageLabel(app)}</span>
			</div>
			{failed && onRetry && (
				<div className="mt-1.5 pl-[18px]">
					<button type="button" data-testid="update-notice-app-retry" onClick={onRetry} className="rounded-sm border border-teal-500/40 bg-teal-500/15 px-2 py-0.5 font-medium text-teal-300 hover:bg-teal-500/25">
						{retryLabel}
					</button>
				</div>
			)}
			{app.state === "ready" && onInstall && (
				<div className="mt-1.5 pl-[18px]">
					<button type="button" onClick={onInstall} className="rounded-sm border border-teal-500/40 bg-teal-500/15 px-2 py-0.5 font-medium text-teal-300 hover:bg-teal-500/25">
						Update now
					</button>
				</div>
			)}
		</div>
	);
}

const APP_SHOWN = new Set(["downloading", "ready", "installing", "failed"]);

export function UpdateNoticeView({ rows, dismissed, onDismiss, app, onInstall, onRetry, retrying, onRetryApp, retryError }: { retryError?: string | null;  rows: Row[]; dismissed: ReadonlySet<string>; onDismiss: (keys: string[]) => void; app?: UpdateState | null; onInstall?: () => void; /** Retry a failed pack update on this console's own machine (clears the held failure and tries again); `retrying` while it is pending. */ onRetry?: () => void; retrying?: boolean; /** Retry a failed Mac app update (checks for updates again). */ onRetryApp?: () => void }) {
	const groups = groupRows(rows, dismissed);
	const showApp = app != null && APP_SHOWN.has(app.state) && !(app.state === "failed" && app.error?.quiet); // an offline laptop failing its background check stays quiet here; the Pack machine card still shows it
	if (!groups.length && !showApp) return null;
	return (
		<div data-testid="update-notice" className="mb-1 flex flex-col gap-1.5">
			{showApp && <AppRow app={app} onInstall={onInstall} onRetry={onRetryApp} />}
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
						{g.failed && onRetry ? (
							<button type="button" data-testid="update-notice-retry" disabled={retrying} onClick={onRetry} className="rounded-sm border border-teal-500/40 bg-teal-500/15 px-2 py-0.5 font-medium text-teal-300 hover:bg-teal-500/25 disabled:pointer-events-none disabled:opacity-50">
								{retryLabel}
							</button>
						) : (
							<Link href={updateHref(g)} className="rounded-sm border border-teal-500/40 bg-teal-500/15 px-2 py-0.5 font-medium text-teal-300 hover:bg-teal-500/25">
								Update now
							</Link>
						)}
						{g.failed && retryError && <p data-testid="update-notice-retry-error" className="mt-1 pl-[18px] text-red-400">{retryError}</p>}
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
	const [reload, setReload] = useState(0);
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
	}, [reload]);
	const dismiss = (keys: string[]) => {
		const next = new Set([...dismissed, ...keys]);
		setDismissed(next);
		try {
			localStorage.setItem(STORE, JSON.stringify([...next]));
		} catch {
			/* storage unavailable: hidden for this page view only */
		}
	};
	const bridge = useAppBridge();
	const app = useAppUpdateState();
	// Retry on this console's own machine: one POST that clears the held failure and tries again; the button stays disabled until it answers.
	const [retrying, setRetrying] = useState(false);
	const [retryError, setRetryError] = useState<string | null>(null);
	const retry = () => {
		if (retrying) return;
		setRetrying(true);
		setRetryError(null);
		void fetch("/api/health/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ service: "update", clearFailed: true }) })
			.then(async (r) => {
				const body = r.status === 202 ? null : await r.json().catch(() => null);
				const out = updateOutcome(r.status, r.headers.get("Retry-After"), body);
				if (out.kind === "error") setRetryError(out.message);
				else if (out.kind === "wait") setRetryError(`Update failed: Too many tries, wait s and try again.`);
			})
			.catch(() => setRetryError("Update failed: Couldn't reach the console, so nothing was sent."))
			.finally(() => (setRetrying(false), setReload((n) => n + 1)));
	};
	return <UpdateNoticeView rows={rows} dismissed={dismissed} onDismiss={dismiss} app={app} onInstall={() => void bridge?.installUpdate?.()} onRetry={retry} retrying={retrying} retryError={retryError} onRetryApp={() => void bridge?.checkForUpdates?.()} />;
}
