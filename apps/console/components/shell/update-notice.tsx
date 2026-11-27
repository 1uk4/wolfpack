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
import { ReleaseNotesModal, useReleaseNotes, type NotesState } from "@/components/shell/release-notes-view";
import { behindFromInventory, hostId, updateOutcome } from "@/src/core";

type Row = { component: string; running: string | null; latest: string | null; outdated: boolean | null; notesUrl: string | null; updateStep?: string; updateStatus?: { state: string; host?: string }; updateState?: { state: string; progress?: number | null; error?: { message: string } } };

/** The hub inventory as the notice reads it: `self` is this console's machine name (GET /api/health/inventory). */
export type OwnInventory = { self: string; /** The name the machine card gives this machine ("Mac"); absent = the raw name. */ selfLabel?: string; rows: { machine: string; kind: string; version?: string; latest?: string | null }[] };

/**
 * Adds this machine's behind wolves and workerd (hub inventory rows of this machine with `latest`) to the /api/updates rows: they join the
 * machine's group, and a component /api/updates already lists for it is not repeated. The machine keeps the name /api/updates uses for it.
 */
function withOwnInventory(rows: Row[], inv: OwnInventory | null | undefined): Row[] {
	if (!inv?.self) return rows;
	const machine = rows.length === 0 || rows.some((r) => r.updateStatus?.host) ? (rows.find((r) => r.updateStatus?.host && hostId(r.updateStatus.host) === hostId(inv.self))?.updateStatus?.host ?? inv.self) : "this machine"; // hostless rows are grouped as "this machine"
	const have = rows.filter((r) => (r.updateStatus?.host || "this machine") === machine).map((r) => r.component);
	const extra = behindFromInventory(inv.rows.filter((r) => hostId(r.machine) === hostId(inv.self)), have);
	return [...rows, ...extra.map((e): Row => ({ component: e.component, running: e.from, latest: e.to, outdated: true, notesUrl: null, updateStatus: { state: "idle", host: machine } }))];
}

const HOUR = 60 * 60_000;
const STORE = "wolfpack.update-notice.dismissed";

type Group = { machine: string; label: string; reason: string | null; items: { component: string; latest: string | null; key: string }[]; failed: boolean; installing: boolean; notesUrl: string | null; notesTag: string | null };

const keyOf = (r: Row) => `${r.component}@${r.latest ?? "?"}`;

function groupRows(rows: Row[], dismissed: ReadonlySet<string>, own?: OwnInventory | null): Group[] {
	const by = new Map<string, Group>();
	for (const r of rows) {
		if (dismissed.has(keyOf(r))) continue;
		const failed = r.updateStatus?.state === "failed";
		const installing = r.updateState?.state === "installing";
		if (r.outdated !== true && !failed && !installing) continue;
		const machine = r.updateStatus?.host || "this machine";
		const isOwn = !!own?.selfLabel && (machine === "this machine" || hostId(machine) === hostId(own.self));
		const g = by.get(machine) ?? { machine, label: isOwn ? own!.selfLabel! : machine, reason: null, items: [], failed: false, installing: false, notesUrl: null, notesTag: null };
		g.installing ||= installing;
		g.items.push({ component: r.component, latest: r.latest, key: keyOf(r) });
		g.failed ||= failed;
		if (failed) g.reason ??= r.updateState?.error?.message ?? null;
		if (!g.notesUrl && r.notesUrl) {
			g.notesUrl = r.notesUrl;
			g.notesTag = r.latest ? `${r.component}/v${r.latest}` : null; // the release tag the manifest's notesUrl points at
		}
		by.set(machine, g);
	}
	return [...by.values()];
}

export const updateHref = (g: Pick<Group, "machine" | "items">) => `/pack/machines?update=${encodeURIComponent(`${g.machine}:${g.items.map((i) => i.component).join(",")}`)}`;

function title(g: Group): string {
	if (g.failed) return `${g.label}: ${failedLine({ error: g.reason ? { code: "", message: g.reason, retryable: false } : undefined })}`;
	if (g.installing) return `${g.label}: ${stageLabel({ state: "installing", progress: null })}`;
	if (g.items.length > 1) return `${g.label}: ${g.items.length} updates available`;
	const i = g.items[0]!;
	return `${g.label}: ${i.component}${i.latest ? ` ${i.latest}` : ""} is available`;
}

/** The Mac app's own stage: shown while downloading, ready, installing or failed; idle/checking/updated stay quiet in the sidebar. */
function AppRow({ app, heading, onInstall, onRetry }: { app: UpdateState; heading?: string; onInstall?: () => void; onRetry?: () => void }) {
	const failed = app.state === "failed";
	return (
		<div data-testid="update-notice-app" className="rounded-md border border-teal-500/30 bg-teal-500/5 px-2.5 py-2 text-xs">
			<div className="flex items-start gap-1.5 text-foreground">
				<ArrowUpCircleIcon className={`mt-0.5 size-3 shrink-0 ${failed ? "text-red-400" : "text-teal-400"}`} />
				<span>{heading ? `${heading}: ` : ""}{failed ? failedLine(app) : stageLabel(app)}</span>
			</div>
			{failed && onRetry && (
				<div className="mt-1.5 pl-[18px]">
					<button type="button" data-testid="update-notice-app-retry" onClick={onRetry} className="inline-flex items-center whitespace-nowrap rounded-sm border border-teal-500/40 bg-teal-500/15 px-2 py-0.5 font-medium text-teal-300 hover:bg-teal-500/25">
						{retryLabel}
					</button>
				</div>
			)}
			{app.state === "ready" && onInstall && (
				<div className="mt-1.5 pl-[18px]">
					<button type="button" onClick={onInstall} className="inline-flex items-center whitespace-nowrap rounded-sm border border-teal-500/40 bg-teal-500/15 px-2 py-0.5 font-medium text-teal-300 hover:bg-teal-500/25">
						Update now
					</button>
				</div>
			)}
		</div>
	);
}

const APP_SHOWN = new Set(["downloading", "ready", "installing", "failed"]);

export function UpdateNoticeView({ ownInventory, appHeading, rows: updateRows, dismissed, onDismiss, app, onInstall, onRetry, retrying, onRetryApp, retryError, onOpenNotes, notes, onCloseNotes }: { /** Remote mode: "This app" heads the Mac app's row. */ appHeading?: string; /** Open the release notes for a machine's row (the container fetches them); with no handler What's new stays a plain link. */ onOpenNotes?: (machine: string, tag: string) => void; /** The open notes: the machine whose row asked and the fetch state. */ notes?: { machine: string; state: NotesState } | null; onCloseNotes?: () => void; retryError?: string | null; /** Hub inventory of this machine: wolves behind show with the update rows. */ ownInventory?: OwnInventory | null; rows: Row[]; dismissed: ReadonlySet<string>; onDismiss: (keys: string[]) => void; app?: UpdateState | null; onInstall?: () => void; /** Retry a failed pack update on this console's own machine (clears the held failure and tries again); `retrying` while it is pending. */ onRetry?: () => void; retrying?: boolean; /** Retry a failed Mac app update (checks for updates again). */ onRetryApp?: () => void }) {
	const groups = groupRows(withOwnInventory(updateRows, ownInventory), dismissed, ownInventory);
	const showApp = app != null && APP_SHOWN.has(app.state) && !(app.state === "failed" && app.error?.quiet); // an offline laptop failing its background check stays quiet here; the Pack machine card still shows it
	if (!groups.length && !showApp) return null;
	return (
		<div data-testid="update-notice" className="mb-1 flex flex-col gap-1.5">
			{showApp && <AppRow app={app} heading={appHeading} onInstall={onInstall} onRetry={onRetryApp} />}
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
					<div className="mt-1.5 flex items-start gap-3 pl-[18px]">
						{g.failed && onRetry ? (
							<button type="button" data-testid="update-notice-retry" disabled={retrying} onClick={onRetry} className="inline-flex items-center whitespace-nowrap rounded-sm border border-teal-500/40 bg-teal-500/15 px-2 py-0.5 font-medium text-teal-300 hover:bg-teal-500/25 disabled:pointer-events-none disabled:opacity-50">
								{retryLabel}
							</button>
						) : (
							<Link href={updateHref(g)} className="inline-flex items-center whitespace-nowrap rounded-sm border border-teal-500/40 bg-teal-500/15 px-2 py-0.5 font-medium text-teal-300 hover:bg-teal-500/25">
								Update now
							</Link>
						)}
						{g.failed && retryError && <p data-testid="update-notice-retry-error" className="mt-1 pl-[18px] text-red-400">{retryError}</p>}
					{g.notesUrl && g.notesTag && onOpenNotes ? (
						<button type="button" onClick={() => onOpenNotes(g.machine, g.notesTag!)} className="text-muted-foreground underline hover:text-foreground">
							What's new
						</button>
					) : g.notesUrl && (
							<a href={g.notesUrl} target="_blank" rel="noreferrer" className="text-muted-foreground underline hover:text-foreground">
								What's new
							</a>
						)}
					</div>
				</div>
			))}
			{notes && (() => {
				const g = groups.find((x) => x.machine === notes.machine);
				return <ReleaseNotesModal state={notes.state} title={g ? `What's new: ${title(g)}` : "What's new"} fallbackUrl={g?.notesUrl} onClose={() => onCloseNotes?.()} />;
			})()}
		</div>
	);
}

/** The notes the user opened (machine + tag), fetched through /api/release-notes. */
function useOpenNotes() {
	const [open, setOpen] = useState<{ machine: string; tag: string } | null>(null);
	const state = useReleaseNotes(open?.tag ?? null);
	return { notes: open ? { machine: open.machine, state } : null, onOpenNotes: (machine: string, tag: string) => setOpen({ machine, tag }), onCloseNotes: () => setOpen(null) };
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
	const [ownInventory, setOwnInventory] = useState<OwnInventory | null>(null);
	const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
	useEffect(() => setDismissed(readDismissed()), []);
	useEffect(() => {
		let alive = true;
		const load = () =>
			void fetch("/api/updates")
				.then((r) => (r.ok ? (r.json() as Promise<{ components?: Row[] }>) : null))
				.then((b) => alive && setRows(b?.components ?? []))
				.catch(() => {});
		// The viewer's own hub read: which wolves of this machine are behind. Unreadable (signed out, hub down) = no extra lines.
		const loadInventory = () =>
			void fetch("/api/health/inventory", { cache: "no-store" })
				.then((r) => (r.ok ? (r.json() as Promise<{ state?: string; rows?: OwnInventory["rows"]; self?: string; selfLabel?: string }>) : null))
				.then((b) => alive && setOwnInventory(b?.state === "ok" && b.self ? { self: b.self, ...(b.selfLabel ? { selfLabel: b.selfLabel } : {}), rows: b.rows ?? [] } : null))
				.catch(() => {});
		load();
		loadInventory();
		const t = setInterval(() => (load(), loadInventory()), HOUR);
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
	const n = useOpenNotes();
	return <UpdateNoticeView {...n} ownInventory={ownInventory} appHeading={bridge?.remote ? "This app" : undefined} rows={rows} dismissed={dismissed} onDismiss={dismiss} app={app} onInstall={() => void bridge?.installUpdate?.()} onRetry={retry} retrying={retrying} retryError={retryError} onRetryApp={() => void bridge?.checkForUpdates?.()} />;
}
