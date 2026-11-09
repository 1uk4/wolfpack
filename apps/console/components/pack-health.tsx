"use client";

/**
 * PACK HEALTH in the sidebar (work-wolfpack-6imFEq7): a one-line status bar, and the full-screen health modal it opens.
 * The data is the console's own /api/health (no hub call), so it keeps working with the hub down; if the console itself stops
 * answering, the bar says so from the last snapshot and never goes blank.
 *   data:  one shared, ref-counted subscription (components/pack-health-store.ts → src/core/pack-health-connection.ts), so
 *          the desktop and phone sidebars share one stream.
 *   modal: rendered once by <PackHealthHost/> (in the app shell), its open state in the store, so closing the phone list
 *          layer under it doesn't unmount it.
 *   dev:   ?healthFixture=<name> and ?healthRestart=<status> (components/pack-health-fixtures.ts; not in production).
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
import { PACK_MAP } from "@/src/core/pack-map";
import {
	ageText,
	BACK_MS,
	errorText,
	historySummary,
	isBack,
	linkName,
	packSummary,
	restartOutcome,
	statusWord,
	toneOf,
	type HealthLink,
	type HealthSnapshotView,
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

const GROUPS: { kind: HealthLink["kind"]; title: string }[] = [
	{ kind: "hubd", title: "Hub" },
	{ kind: "workerd", title: "Workers" },
	{ kind: "wolfd", title: "Wolves" },
];

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
					GROUPS.map((g) => {
						const rows = snapshot.links.filter((l) => l.kind === g.kind);
						if (rows.length === 0) return null;
						return (
							<section key={g.kind} className="mb-4">
								<h3 className="mb-1.5 text-xs uppercase tracking-widest text-muted-foreground/70">{g.title}</h3>
								<div className="flex flex-col gap-1.5">
									{rows.map((l) => (
										<LinkRow key={l.id} link={l} now={now} canRestart={reachable} fakeRestart={health.fakeRestart} />
									))}
								</div>
							</section>
						);
					})
				)}
				<PackMap />
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

type RestartUi = { phase: "idle" } | { phase: "confirm" } | { phase: "sending" } | { phase: "issued"; at: number } | { phase: "wait"; until: number } | { phase: "error"; message: string };

function LinkRow({ link, now, canRestart, fakeRestart }: { link: HealthLink; now: number; canRestart: boolean; fakeRestart: number | null }) {
	const [ui, setUi] = useState<RestartUi>({ phase: "idle" });
	const [tick, setTick] = useState(0);
	const back = isBack(link, now);
	const tone = toneOf(link.status);
	const word = back ? "back" : statusWord(link.status);
	const err = link.status === "ok" ? null : errorText(link.error);
	const story = historySummary(link.history, 5);
	const waitS = ui.phase === "wait" ? Math.max(0, Math.ceil((ui.until - Date.now()) / 1000)) : 0;

	// The 429 countdown ticks every second, then the button comes back.
	useEffect(() => {
		if (ui.phase !== "wait") return;
		if (waitS <= 0) return setUi({ phase: "idle" });
		const t = setTimeout(() => setTick((n) => n + 1), 1000);
		return () => clearTimeout(t);
	}, [ui, waitS, tick]);
	// "Restart sent" gives way once the monitor reports the row as restarting (or after 15 s).
	useEffect(() => {
		if (ui.phase === "issued" && (link.status === "restarting" || now - ui.at > 15_000)) setUi({ phase: "idle" });
	}, [ui, link.status, now]);

	const restart = useCallback(async () => {
		setUi({ phase: "sending" });
		let status = 0;
		let retry: string | null = null;
		if (fakeRestart !== null) {
			status = fakeRestart;
			retry = fakeRestart === 429 ? "8" : null;
		} else {
			try {
				// The hub-auth fetch wrapper (components/hub-auth.tsx) adds the device bearer to every /api/ call.
				const r = await fetch("/api/health/restart", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ service: link.id }) });
				status = r.status;
				retry = r.headers.get("Retry-After");
			} catch {
				status = 0;
			}
		}
		const out = restartOutcome(status, retry);
		if (out.kind === "issued") setUi({ phase: "issued", at: Date.now() });
		else if (out.kind === "wait") setUi({ phase: "wait", until: Date.now() + out.retryS * 1000 });
		else setUi({ phase: "error", message: out.message });
	}, [fakeRestart, link.id]);

	const stats = [
		link.responseMs !== null ? `${link.responseMs} ms` : null,
		link.lagMs !== null ? `lag ${link.lagMs} ms` : null,
		link.version ? `v${link.version}` : null,
		link.uptimeS !== null ? `up ${durationText(link.uptimeS)}` : null,
		link.via ? `via ${link.via}` : null,
	].filter(Boolean);

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
				<span className="ml-auto flex items-center gap-2">
					{link.restartable && <RestartControl ui={ui} waitS={waitS} disabled={!canRestart || link.status === "restarting"} onAsk={() => setUi({ phase: "confirm" })} onCancel={() => setUi({ phase: "idle" })} onConfirm={() => void restart()} name={linkName(link)} />}
				</span>
			</div>
			{err && <p className="mt-1 text-muted-foreground">{err}</p>}
			<p className="mt-1 text-muted-foreground/80">
				{stats.join(" · ")}
				{stats.length > 0 && " · "}
				{link.lastOkAt ? `last OK ${ageText(now - Date.parse(link.lastOkAt))}` : "never OK"}
				{link.lastRestart && ` · restart ${link.lastRestart.ok ? "issued" : "failed"} ${ageText(now - Date.parse(link.lastRestart.at))}`}
			</p>
			{story && <p data-testid="pack-health-history" className="mt-1 break-words text-muted-foreground/70">{story}</p>}
			{ui.phase === "error" && <p data-testid="pack-health-restart-error" className="mt-1 text-red-600 dark:text-red-400">{ui.message}</p>}
		</div>
	);
}

function RestartControl({ ui, waitS, disabled, name, onAsk, onCancel, onConfirm }: { ui: RestartUi; waitS: number; disabled: boolean; name: string; onAsk: () => void; onCancel: () => void; onConfirm: () => void }) {
	const btn = "rounded-sm px-2.5 py-1 text-xs transition-colors max-md:px-3 max-md:py-2";
	if (ui.phase === "confirm")
		return (
			<span className="flex items-center gap-1" data-testid="pack-health-confirm">
				<span className="text-muted-foreground">Restart {name}?</span>
				<button type="button" onClick={onCancel} className={cn(btn, "text-muted-foreground hover:text-foreground")}>Cancel</button>
				<button type="button" data-testid="pack-health-restart-confirm" onClick={onConfirm} className={cn(btn, "border border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/20")}>Restart</button>
			</span>
		);
	if (ui.phase === "sending") return <BrailleSpinner className="h-[1.25em]" label="Sending restart" />;
	if (ui.phase === "issued") return <span className="text-muted-foreground">Restart sent</span>;
	if (ui.phase === "wait") return <span data-testid="pack-health-wait" className="text-amber-600 dark:text-amber-400">Too many tries · retry in {waitS}s</span>;
	return (
		<button type="button" data-testid="pack-health-restart" disabled={disabled} onClick={onAsk} className={cn(btn, "border text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50")}>
			Restart
		</button>
	);
}

function PackMap() {
	return (
		<section className="mt-2" data-testid="pack-map">
			<h3 className="mb-1.5 text-xs uppercase tracking-widest text-muted-foreground/70">Where things run</h3>
			<div className="grid gap-2 md:grid-cols-2">
				{PACK_MAP.map((h) => (
					<div key={h.host} className="rounded-lg border bg-card px-3 py-2">
						<div className="mb-1 font-medium text-foreground">{h.host}</div>
						<ul className="mb-1.5 flex flex-col gap-0.5">
							{h.services.map((s) => (
								<li key={s.name}>
									<span className="text-foreground">{s.name}</span> <span className="text-muted-foreground">{s.at}</span>
									<span className="block text-muted-foreground/70">{s.what}</span>
								</li>
							))}
						</ul>
						<ul className="mb-1.5 flex flex-col gap-0.5">
							{h.stores.map((s) => (
								<li key={s.name}>
									<span className="text-foreground">{s.name}</span> <span className="break-all text-muted-foreground">{s.path}</span>
								</li>
							))}
						</ul>
						<p className="text-muted-foreground/70">Backups: {h.backups}</p>
					</div>
				))}
			</div>
		</section>
	);
}
