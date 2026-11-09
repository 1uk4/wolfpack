"use client";

/**
 * PACK HEALTH in the sidebar (work-wolfpack-6imFEq7): a one-line status bar, and the full-screen health modal it opens.
 * The data is the console's own /api/health (no hub call), so it keeps working with the hub down; if the console itself stops
 * answering, the bar says so from the last snapshot and never goes blank.
 *   data:  one shared, ref-counted subscription (components/pack-health-store.ts → src/core/pack-health-connection.ts), so
 *          the desktop and phone sidebars share one stream.
 *   modal: rendered once by <PackHealthHost/> (in the app shell), its open state in the store, so closing the phone list
 *          layer under it doesn't unmount it.
 *   actions (work-wolfpack-yM3uTlj): per row Restart, Logs (inline panel: refresh, copy) and Roll back (hubd, the workerd link unit; the
 *          console itself in its own row), all through this console server (/api/health/{restart,logs,rollback}), never a wolf. Off systemd
 *          (the Mac stack) a row shows copyable `pnpm stack` commands instead.
 *   dev:   ?healthFixture=<name>, ?healthRestart= / ?healthLogs= / ?healthRollback=<status> (components/pack-health-fixtures.ts; not in production).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { BrailleSpinner } from "@/components/braille-spinner";
import { OverlayHeader, OverlayShell } from "@/components/overlay-shell";
import {
	closePackHealth,
	focusPackHealthOpener,
	getPackHealth,
	getServerPackHealth,
	openPackHealth,
	subscribePackHealth,
	watchPackHealth,
	type PackHealthState,
} from "@/components/pack-health-store";
import { cn } from "@/lib/utils";
import { groupByHost, type HostCard } from "@/src/core/pack-hosts";
import type { PackMapHost } from "@/src/core/pack-map";
import {
	ageText,
	BACK_MS,
	errorText,
	historySummary,
	isBack,
	linkName,
	logsOutcome,
	packSummary,
	restartOutcome,
	rollbackFinished,
	rollbackOffered,
	rollbackOutcome,
	rollbackQuestion,
	rowActions,
	statusWord,
	toneOf,
	type HealthActionsView,
	type HealthLink,
	type HealthSnapshotView,
	type RestartOutcome,
	type Tone,
} from "@/src/core/pack-health-view";

const DOT: Record<Tone, string> = { red: "bg-red-500", amber: "bg-amber-500", grey: "bg-muted-foreground/50", green: "bg-emerald-500" };
const TEXT: Record<Tone, string> = { red: "text-red-600 dark:text-red-400", amber: "text-amber-600 dark:text-amber-400", grey: "text-muted-foreground", green: "text-emerald-600 dark:text-emerald-400" };
const TICK_MS = 2_000;

type HealthState = PackHealthState & { now: number };

/** When the latest "back" window ends (0 when none): a link that turned ok after being anything else. */
function backUntil(snapshot: HealthSnapshotView | null): number {
	let until = 0;
	for (const l of snapshot?.links ?? []) {
		const last = l.history[l.history.length - 1];
		if (l.status === "ok" && l.history.length >= 2 && last?.status === "ok") until = Math.max(until, Date.parse(last.at) + BACK_MS);
	}
	return until;
}

/**
 * The shared snapshot plus a clock. The clock ticks every 2 s only while the modal is open or a "back" window is pending;
 * otherwise it moves with each store update (a snapshot or a failed poll).
 */
function usePackHealth(): HealthState {
	const s = useSyncExternalStore(subscribePackHealth, getPackHealth, getServerPackHealth);
	const [now, setNow] = useState(() => Date.now());
	const until = backUntil(s.snapshot);
	useEffect(() => {
		setNow(Date.now());
		const ticking = () => s.modalOpen || Date.now() < until;
		if (!ticking()) return;
		const t = setInterval(() => {
			setNow(Date.now());
			if (!ticking()) clearInterval(t);
		}, TICK_MS);
		return () => clearInterval(t);
	}, [s.modalOpen, until, s.updatedAt]);
	return { ...s, now };
}

/** The sidebar row: overall dot + short label; opens the modal. */
export function PackHealthBar({ onOpen }: { onOpen?: () => void }) {
	const h = usePackHealth();
	const ref = useRef<HTMLButtonElement>(null);
	const sum = packSummary({ snapshot: h.snapshot, reachable: h.reachable, lastSeenAt: h.lastSeenAt, now: h.now });
	return (
		<button
			ref={ref}
			type="button"
			data-testid="pack-health-bar"
			data-tone={sum.tone}
			aria-haspopup="dialog"
			onClick={() => {
				openPackHealth(ref.current);
				onOpen?.();
			}}
			aria-label={`Pack health: ${sum.label}`}
			className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground max-md:py-2.5"
		>
			<span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[sum.tone])} />
			<span className="uppercase tracking-wider">Pack</span>
			<span className={cn("min-w-0 flex-1 truncate", sum.tone !== "green" && TEXT[sum.tone])}>{sum.label}</span>
		</button>
	);
}

/** What the live region says: the overall summary without the ticking age, so only real changes are announced. */
function announcement(s: PackHealthState): string {
	if (!s.reachable) return "Pack health: console unreachable";
	if (!s.snapshot) return "";
	return `Pack health: ${packSummary({ snapshot: s.snapshot, reachable: true, now: s.updatedAt }).label}`;
}

/**
 * Rendered once in the app shell: the modal (portaled to body, above the phone list layer and outside the sidebar's
 * aria-hidden aside) and a polite live region for changes of the overall summary. It watches the store without counting
 * as a subscriber; the bars and the open modal are the subscribers (openPackHealth takes the modal's hold on the stream,
 * closePackHealth drops it, and unmounting the host with the modal open closes it).
 */
export function PackHealthHost() {
	const s = useSyncExternalStore(watchPackHealth, getPackHealth, getServerPackHealth);
	const said = announcement(s);
	const prev = useRef("");
	const [live, setLive] = useState("");
	useEffect(() => {
		if (said === "") return;
		if (prev.current !== "" && said !== prev.current) setLive(said); // the state on page load is not news
		prev.current = said;
	}, [said]);
	useEffect(() => () => void (getPackHealth().modalOpen && closePackHealth()), []);
	const wasOpen = useRef(false);
	useEffect(() => {
		if (wasOpen.current && !s.modalOpen) focusPackHealthOpener(); // after OverlayShell's own restore, which may hit a hidden bar
		wasOpen.current = s.modalOpen;
	}, [s.modalOpen]);
	return (
		<>
			<div aria-live="polite" role="status" className="sr-only" data-testid="pack-health-live">
				{live}
			</div>
			{s.modalOpen && typeof document !== "undefined" && createPortal(<PackHealthModal onClose={closePackHealth} />, document.body)}
		</>
	);
}

function PackHealthModal({ onClose }: { onClose: () => void }) {
	const health = usePackHealth();
	const { snapshot, reachable, lastSeenAt, now } = health;
	const sum = packSummary({ snapshot, reachable, lastSeenAt, now });
	return (
		<OverlayShell
			labelledBy="pack-health-title"
			testId="pack-health-modal"
			closeTestId="pack-health-close"
			onClose={onClose}
			header={(close) => (
				// pl-4 undoes the header's -ml-4 so the title lines up with the body's px-4 (the Electron lights gutter still wins).
				<OverlayHeader className="flex items-center gap-2 pb-3 pl-4">
					<h2 id="pack-health-title" className="text-sm font-semibold">Pack health</h2>
					<span className={cn("flex min-w-0 items-center gap-1.5 truncate text-xs", TEXT[sum.tone])}>
						<span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[sum.tone])} />
						{sum.label}
					</span>
					{close}
				</OverlayHeader>
			)}
		>
			<div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto pb-6 text-xs">
				{!reachable && (
					<p data-testid="pack-health-unreachable" className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-red-700 dark:text-red-300">
						This console's server is not answering. The rows below are its last report{lastSeenAt !== null ? ` (${ageText(now - lastSeenAt)})` : ""}; restarts need it back.
					</p>
				)}
				{snapshot === null ? (
					<p className="text-muted-foreground">{reachable ? "Checking the pack…" : "No report yet."}</p>
				) : (
					groupByHost(snapshot).map((c) => <HostSection key={c.id} card={c} now={now} canAct={reachable} actions={snapshot.actions} fakes={health} />)
				)}
				{snapshot?.checkedAt && <p className="mt-3 text-muted-foreground/70">Checked {ageText(now - Date.parse(snapshot.checkedAt))} · every {Math.round(snapshot.intervalMs / 1000)} s</p>}
			</div>
		</OverlayShell>
	);
}

function durationText(s: number): string {
	if (s < 60) return `${Math.floor(s)}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ${m % 60}m`;
	return `${Math.floor(h / 24)}d ${h % 24}h`;
}

type ActionUi = { phase: "idle" } | { phase: "confirm" } | { phase: "sending" } | { phase: "issued"; at: number } | { phase: "wait"; until: number } | { phase: "error"; message: string };
type Fakes = Pick<PackHealthState, "fakeRestart" | "fakeLogs" | "fakeRollback">;

/** Clipboard with a fallback for contexts without the async clipboard API. */
async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		try {
			const ta = document.createElement("textarea");
			ta.value = text;
			ta.style.position = "fixed";
			ta.style.opacity = "0";
			document.body.appendChild(ta);
			ta.select();
			const ok = document.execCommand("copy");
			ta.remove();
			return ok;
		} catch {
			return false;
		}
	}
}

/**
 * One confirmable POST action (restart or roll back): confirm, send, then "sent", a 429 countdown, or an error line. `fake` answers with a
 * status instead of calling the server (dev fixtures).
 */
function useAction(url: string, service: string, outcome: (status: number, retryAfter: string | null, body?: unknown) => RestartOutcome, fake: number | null) {
	const [ui, setUi] = useState<ActionUi>({ phase: "idle" });
	const [tick, setTick] = useState(0);
	const waitS = ui.phase === "wait" ? Math.max(0, Math.ceil((ui.until - Date.now()) / 1000)) : 0;
	useEffect(() => {
		if (ui.phase !== "wait") return;
		if (waitS <= 0) return setUi({ phase: "idle" });
		const t = setTimeout(() => setTick((n) => n + 1), 1000);
		return () => clearTimeout(t);
	}, [ui, waitS, tick]);
	const send = useCallback(async () => {
		setUi({ phase: "sending" });
		let status = 0;
		let retry: string | null = null;
		let body: unknown = null;
		if (fake !== null) {
			status = fake;
			retry = fake === 429 ? "8" : null;
		} else {
			try {
				// The hub-auth fetch wrapper (components/hub-auth.tsx) adds the device bearer to every /api/ call.
				const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ service }) });
				status = r.status;
				retry = r.headers.get("Retry-After");
				if (status !== 202) body = await r.json().catch(() => null);
			} catch {
				status = 0;
			}
		}
		const out = outcome(status, retry, body);
		if (out.kind === "issued") setUi({ phase: "issued", at: Date.now() });
		else if (out.kind === "wait") setUi({ phase: "wait", until: Date.now() + out.retryS * 1000 });
		else setUi({ phase: "error", message: out.message });
	}, [fake, url, service, outcome]);
	return { ui, setUi, waitS, send };
}

const BTN = "rounded-sm px-2.5 py-1 text-xs transition-colors max-md:px-3 max-md:py-2";
const QUIET_BTN = cn(BTN, "border text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50");

function LinkRow({ link, now, canRestart, actions, fakes }: { link: HealthLink; now: number; canRestart: boolean; actions: HealthActionsView | undefined; fakes: Fakes }) {
	const restart = useAction("/api/health/restart", link.id, restartOutcome, fakes.fakeRestart);
	const can = rowActions(link, actions);
	const rollback = useAction("/api/health/rollback", can.rollback?.service ?? "", rollbackOutcome, fakes.fakeRollback);
	const [logsOpen, setLogsOpen] = useState(false);
	const back = isBack(link, now);
	const tone = toneOf(link.status);
	const word = back ? "back" : statusWord(link.status);
	const err = link.status === "ok" ? null : errorText(link.error);
	const story = historySummary(link.history, 5);
	const { ui, setUi } = restart;

	// "Restart sent" gives way once the monitor reports the row as restarting (or after 15 s).
	useEffect(() => {
		if (ui.phase === "issued" && (link.status === "restarting" || now - ui.at > 15_000)) setUi({ phase: "idle" });
	}, [ui, link.status, now, setUi]);
	const rbUi = rollback.ui;
	const rbSetUi = rollback.setUi;
	const rbInfo = can.rollback ? actions?.rollback.find((r) => r.service === can.rollback!.service) : undefined;
	useRollbackProgress(rollback, rbInfo?.last, link.version, now);

	const stats = [
		link.responseMs !== null ? `${link.responseMs} ms` : null,
		link.lagMs !== null ? `lag ${link.lagMs} ms` : null,
		link.version ? `v${link.version}` : null,
		link.uptimeS !== null ? `up ${durationText(link.uptimeS)}` : null,
		link.via && link.source !== "hub" ? `via ${link.via}` : null,
		link.source === "hub" ? "via hub" : null,
		link.source === "hub" && link.since ? `since ${ageText(now - Date.parse(link.since)).replace(/ ago$/, "")}` : null,
		link.hubPresence && link.hubPresence !== "online" ? `hub sees it ${link.hubPresence}` : null,
		link.hubStatus === "offline" && link.status === "ok" ? "hub sees it offline" : null,
	].filter(Boolean);
	const staleHub = link.source === "hub" && link.error === "hub_stale" && link.hubSeenAt;
	const busy = ui.phase !== "idle" || rbUi.phase !== "idle";

	return (
		<div data-testid="pack-health-row" data-link={link.id} data-status={link.status} className="rounded-lg border bg-card px-3 py-2">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[back ? "green" : tone])} />
				<span className="font-medium text-foreground">{linkName(link)}</span>
				{link.kind !== "hubd" && link.id !== linkName(link) && <span className="text-muted-foreground/70">{link.id}</span>}
				<span className={cn("flex items-center gap-1", TEXT[back ? "green" : tone])} data-testid="pack-health-status">
					{link.status === "restarting" && <BrailleSpinner className="h-[1.25em] text-current" label="restarting" />}
					{word}
				</span>
				<span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
					{ui.phase !== "idle" ? (
						<ActionControl verb="Restart" sentText="Restart sent" testId="pack-health-restart" ui={ui} waitS={restart.waitS} disabled={false} question={`Restart ${linkName(link)}?`} onAsk={() => setUi({ phase: "confirm" })} onCancel={() => setUi({ phase: "idle" })} onConfirm={() => void restart.send()} />
					) : rbUi.phase !== "idle" ? (
						<ActionControl verb="Roll back" sentText="Rollback started" testId="pack-health-rollback" ui={rbUi} waitS={rollback.waitS} disabled={false} question={`${rollbackQuestion(linkName(link), rbInfo?.from ?? null, can.rollback?.to ?? null)}${link.id === "workerd" ? " Only the link unit: workerd-wolves keeps its own release." : ""}`} onAsk={() => rbSetUi({ phase: "confirm" })} onCancel={() => rbSetUi({ phase: "idle" })} onConfirm={() => void rollback.send()} />
					) : (
						<>
							{can.logs && (
								<button type="button" data-testid="pack-health-logs" aria-expanded={logsOpen} onClick={() => setLogsOpen((o) => !o)} className={QUIET_BTN}>
									Logs
								</button>
							)}
							{can.rollback && (
								<button type="button" data-testid="pack-health-rollback" disabled={!canRestart || busy} onClick={() => rbSetUi({ phase: "confirm" })} className={QUIET_BTN}>
									Roll back
								</button>
							)}
							{can.restart && (
								<button type="button" data-testid="pack-health-restart" disabled={!canRestart || link.status === "restarting"} onClick={() => setUi({ phase: "confirm" })} className={QUIET_BTN}>
									Restart
								</button>
							)}
						</>
					)}
				</span>
			</div>
			{err && <p className="mt-1 text-muted-foreground">{err}</p>}
			<p className="mt-1 text-muted-foreground/80">
				{stats.join(" · ")}
				{stats.length > 0 && " · "}
				{staleHub ? `last seen from the hub ${ageText(now - Date.parse(link.hubSeenAt!))}` : link.source === "hub" ? (link.lastCheckedAt ? `hub checked ${ageText(now - Date.parse(link.lastCheckedAt))}` : "") : link.lastOkAt ? `last OK ${ageText(now - Date.parse(link.lastOkAt))}` : "never OK"}
				{link.lastRestart && ` · restart ${link.lastRestart.ok ? "issued" : "failed"} ${ageText(now - Date.parse(link.lastRestart.at))}`}
			</p>
			{story && <p data-testid="pack-health-history" className="mt-1 break-words text-muted-foreground/70">{story}</p>}
			{ui.phase === "error" && <p data-testid="pack-health-restart-error" className="mt-1 text-red-600 dark:text-red-400">{ui.message}</p>}
			{rbUi.phase === "error" && <p data-testid="pack-health-rollback-error" className="mt-1 text-red-600 dark:text-red-400">{rbUi.message}</p>}
			{logsOpen && <LogsPanel service={link.id} fake={fakes.fakeLogs} canFetch={canRestart} />}
		</div>
	);
}

type RollbackLastView = NonNullable<HealthActionsView["rollback"][number]["last"]>;

/**
 * "Rollback started" until the rollback unit reports a run newer than the one seen at send (actions.rollback[svc].last). A failed run
 * turns into its error line (exit code in words, see Logs). A finished run clears once the running version changes (full string, so a
 * build-only rollback counts), or 2 min after it finished. Nothing reported at all: cleared after 5 min.
 */
function useRollbackProgress(rollback: ReturnType<typeof useAction>, last: RollbackLastView | null | undefined, version: string | null, now: number) {
	const { ui, setUi } = rollback;
	const [sent, setSent] = useState<{ after: string | null; version: string | null; doneAt: number | null } | null>(null);
	useEffect(() => {
		if (ui.phase !== "issued") {
			if (sent) setSent(null);
			return;
		}
		if (!sent) return void setSent({ after: last?.at ?? null, version, doneAt: null });
		const done = rollbackFinished(last, sent.after);
		if (done && !done.ok) return void setUi({ phase: "error", message: done.message });
		if (done?.ok && sent.doneAt === null) return void setSent({ ...sent, doneAt: now });
		const moved = version !== null && version !== sent.version;
		if ((sent.doneAt !== null && (moved || now - sent.doneAt > 120_000)) || now - ui.at > 300_000) setUi({ phase: "idle" });
	}, [ui, sent, last, version, now, setUi]);
}

/** The console's own row (it is not a probed link): only roll back, since it is the thing serving this page. */
function ConsoleRow({ actions, canAct, fakes }: { actions: HealthActionsView | undefined; canAct: boolean; fakes: Fakes }) {
	const rb = actions?.rollback.find((r) => r.service === "console");
	const rollback = useAction("/api/health/rollback", "console", rollbackOutcome, fakes.fakeRollback);
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (rollback.ui.phase !== "issued") return;
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [rollback.ui.phase]);
	useRollbackProgress(rollback, rb?.last, rb?.from ?? null, now);
	// No kept release, or one that is newer (it was just rolled back): nothing to offer; a running rollback still shows.
	const offer = !!rb && (rollbackOffered(rb) || rollback.ui.phase !== "idle");
	return (
		<div data-testid="pack-health-row" data-link="console" className="rounded-lg border bg-card px-3 py-2">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[canAct ? "green" : "red"])} />
				<span className="font-medium text-foreground">Console</span>
				<span className="text-muted-foreground/70">this page</span>
				{rb?.from && <span className="text-muted-foreground/80">v{rb.from}</span>}
				{offer && rb && (
					<span className="ml-auto flex items-center gap-1.5">
						<ActionControl
							verb="Roll back"
							sentText="Rollback started; this page reconnects when the console is back"
							testId="pack-health-rollback"
							ui={rollback.ui}
							waitS={rollback.waitS}
							disabled={!canAct}
							question={rollbackQuestion("the console", rb.from, rb.to)}
							onAsk={() => rollback.setUi({ phase: "confirm" })}
							onCancel={() => rollback.setUi({ phase: "idle" })}
							onConfirm={() => void rollback.send()}
						/>
					</span>
				)}
			</div>
			{rollback.ui.phase === "error" && <p data-testid="pack-health-rollback-error" className="mt-1 text-red-600 dark:text-red-400">{rollback.ui.message}</p>}
		</div>
	);
}

function ActionControl(p: { verb: string; sentText: string; testId: string; ui: ActionUi; waitS: number; disabled: boolean; question: string; onAsk: () => void; onCancel: () => void; onConfirm: () => void }) {
	const { ui } = p;
	if (ui.phase === "confirm")
		return (
			<span className="flex flex-wrap items-center justify-end gap-1" data-testid="pack-health-confirm">
				<span className="text-muted-foreground">{p.question}</span>
				<button type="button" onClick={p.onCancel} className={cn(BTN, "text-muted-foreground hover:text-foreground")}>Cancel</button>
				<button type="button" data-testid={`${p.testId}-confirm`} onClick={p.onConfirm} className={cn(BTN, "border border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/20")}>{p.verb}</button>
			</span>
		);
	if (ui.phase === "sending") return <BrailleSpinner className="h-[1.25em]" label={`Sending ${p.verb.toLowerCase()}`} />;
	if (ui.phase === "issued") return <span className="text-muted-foreground">{p.sentText}</span>;
	if (ui.phase === "wait") return <span data-testid="pack-health-wait" className="text-amber-600 dark:text-amber-400">Too many tries · retry in {p.waitS >= 120 ? `${Math.ceil(p.waitS / 60)} min` : `${p.waitS}s`}</span>;
	return (
		<button type="button" data-testid={p.testId} disabled={p.disabled} onClick={p.onAsk} className={QUIET_BTN}>
			{p.verb}
		</button>
	);
}

type LogsUi = { phase: "loading" } | { phase: "lines"; lines: string[]; truncated: boolean; at: number } | { phase: "wait"; retryS: number } | { phase: "error"; message: string };

/** The unit's recent journal (GET /api/health/logs), redacted server-side. Refresh and copy; wraps instead of scrolling sideways. */
function LogsPanel({ service, fake, canFetch }: { service: string; fake: number | null; canFetch: boolean }) {
	const [ui, setUi] = useState<LogsUi>({ phase: "loading" });
	const [copied, setCopied] = useState<boolean | null>(null);
	const box = useRef<HTMLPreElement>(null);
	const load = useCallback(async () => {
		setUi({ phase: "loading" });
		setCopied(null);
		let status = 0;
		let body: unknown = null;
		let retry: string | null = null;
		if (fake !== null) {
			status = fake;
			const { fixtureLogs } = await import("@/components/pack-health-fixtures");
			body = fake === 200 ? fixtureLogs(service, Date.now()) : { code: fake === 501 ? "unsupported" : fake === 502 ? "journal_denied" : "failed" };
			retry = fake === 429 ? "3" : null;
		} else {
			try {
				const r = await fetch(`/api/health/logs?service=${encodeURIComponent(service)}&lines=100`, { cache: "no-store" });
				status = r.status;
				retry = r.headers.get("Retry-After");
				body = await r.json().catch(() => null);
			} catch {
				status = 0;
			}
		}
		const out = logsOutcome(status, body, retry);
		if (out.kind === "lines") setUi({ phase: "lines", lines: out.lines, truncated: out.truncated, at: Date.now() });
		else if (out.kind === "wait") setUi({ phase: "wait", retryS: out.retryS });
		else setUi({ phase: "error", message: out.message });
	}, [service, fake]);
	useEffect(() => {
		if (canFetch) void load();
		else setUi({ phase: "error", message: "Console unreachable; logs not loaded" });
	}, [load, canFetch]);
	useEffect(() => {
		if (ui.phase === "lines" && box.current) box.current.scrollTop = box.current.scrollHeight; // newest at the bottom, in view
	}, [ui]);
	return (
		<div data-testid="pack-health-logs-panel" className="mt-2 rounded-md border bg-muted/40">
			<div className="flex flex-wrap items-center gap-2 border-b px-2 py-1">
				<span className="text-muted-foreground">
					Recent logs{ui.phase === "lines" ? ` · ${ui.lines.length} lines${ui.truncated ? " (newest)" : ""}` : ""}
				</span>
				<span className="ml-auto flex items-center gap-1.5">
					{copied !== null && <span className="text-muted-foreground">{copied ? "Copied" : "Copy failed"}</span>}
					<button type="button" data-testid="pack-health-logs-copy" disabled={ui.phase !== "lines"} onClick={() => ui.phase === "lines" && void copyText(ui.lines.join("\n")).then(setCopied)} className={QUIET_BTN}>
						Copy
					</button>
					<button type="button" data-testid="pack-health-logs-refresh" disabled={ui.phase === "loading" || !canFetch} onClick={() => void load()} className={QUIET_BTN}>
						Refresh
					</button>
				</span>
			</div>
			{ui.phase === "loading" && <div className="px-2 py-2"><BrailleSpinner className="h-[1.25em]" label="Loading logs" /></div>}
			{ui.phase === "wait" && <p className="px-2 py-2 text-amber-600 dark:text-amber-400">Busy · try again in {ui.retryS}s</p>}
			{ui.phase === "error" && <p data-testid="pack-health-logs-error" className="px-2 py-2 text-red-600 dark:text-red-400">{ui.message}</p>}
			{ui.phase === "lines" &&
				(ui.lines.length === 0 ? (
					<p className="px-2 py-2 text-muted-foreground">No journal entries.</p>
				) : (
					<pre ref={box} className="max-h-72 overflow-y-auto whitespace-pre-wrap break-all px-2 py-1.5 font-mono text-[11px] leading-snug text-foreground/90">
						{ui.lines.join("\n")}
					</pre>
				))}
		</div>
	);
}

/** Off systemd (the Mac live stack): no restart path from here, just the commands to run by hand, copyable. */
function MacCommands({ commands }: { commands: string[] }) {
	const [copied, setCopied] = useState<string | null>(null);
	return (
		<div data-testid="pack-health-mac" className="mt-1.5 flex flex-col gap-1">
			<span className="text-muted-foreground/80">On the Mac, run:</span>
			{commands.map((c) => (
				<span key={c} className="flex min-w-0 items-center gap-1.5">
					<code className="min-w-0 flex-1 truncate rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px]">{c}</code>
					<button type="button" onClick={() => void copyText(c).then((ok) => setCopied(ok ? c : null))} className={QUIET_BTN} aria-label={`Copy ${c}`}>
						{copied === c ? "Copied" : "Copy"}
					</button>
				</span>
			))}
		</div>
	);
}

/**
 * One host (work-wolfpack-w7RPvtd): its hub, its workerd units with the wolves each runs nested under it, this console if it runs here,
 * and the host's map facts (services, paths, backups) folded away at the bottom. A map host with nothing probed from here: facts only.
 */
function HostSection({ card, now, canAct, actions, fakes }: { card: HostCard; now: number; canAct: boolean; actions: HealthActionsView | undefined; fakes: Fakes }) {
	const row = (l: HealthLink) => <LinkRow key={l.id} link={l} now={now} canRestart={canAct} actions={actions} fakes={fakes} />;
	const note = !card.checked ? "not checked from here" : card.console ? "this console runs here" : "checked over the network";
	const titleId = "pack-host-" + card.id.replace(/[^a-z0-9-]/g, "-");
	// The Mac stack commands are the same for every row of a host: shown once, at the foot of the card.
	const macCommands = [...card.workerds.flatMap((w) => [w.link, ...w.wolves]), ...card.wolves].map((l) => rowActions(l, actions).macCommands).find((c) => c !== null) ?? null;
	return (
		<section data-testid="pack-host" data-host={card.id} aria-labelledby={titleId} className="mb-4">
			<h3 id={titleId} className="mb-1.5 flex flex-wrap items-baseline gap-x-2 text-xs">
				<span className="font-semibold uppercase tracking-widest text-muted-foreground">{card.label}</span>
				{card.label !== card.id && card.checked && <span className="text-muted-foreground/60">{card.id}</span>}
				<span className="text-muted-foreground/60">· {note}</span>
			</h3>
			<div className="flex flex-col gap-1.5">
				{card.hub && row(card.hub)}
				{card.workerds.map((w) => (
					<div key={w.link.id} className="flex flex-col gap-1.5">
						{row(w.link)}
						{w.wolves.length > 0 && (
							<div data-testid="pack-host-wolves" data-via={w.link.id} className="ml-3 flex flex-col gap-1.5 border-l pl-2.5">
								{w.wolves.map(row)}
							</div>
						)}
					</div>
				))}
				{card.wolves.map(row)}
				{card.console && <ConsoleRow actions={actions} canAct={canAct} fakes={fakes} />}
				{macCommands && <MacCommands commands={macCommands} />}
				{card.facts && <HostFacts facts={card.facts} open={!card.checked} />}
			</div>
		</section>
	);
}

/** A host's static map facts (pack-map.ts), quiet and collapsible (open on a card that has nothing else). */
function HostFacts({ facts, open }: { facts: PackMapHost; open: boolean }) {
	return (
		<details data-testid="pack-map" open={open} className="rounded-lg border border-dashed px-3 py-1.5 text-muted-foreground">
			<summary className="cursor-pointer select-none py-0.5 text-muted-foreground/80 hover:text-foreground max-md:py-1.5">Services, paths and backups</summary>
			<ul className="mt-1 mb-1.5 flex flex-col gap-0.5">
				{facts.services.map((s) => (
					<li key={s.name}>
						<span className="text-foreground/80">{s.name}</span> <span className="break-all">{s.at}</span>
						<span className="block text-muted-foreground/70">{s.what}</span>
					</li>
				))}
			</ul>
			<ul className="mb-1.5 flex flex-col gap-0.5">
				{facts.stores.map((s) => (
					<li key={s.name}>
						<span className="text-foreground/80">{s.name}</span> <span className="break-all">{s.path}</span>
					</li>
				))}
			</ul>
			<p className="mb-1 text-muted-foreground/70">Backups: {facts.backups}</p>
		</details>
	);
}
