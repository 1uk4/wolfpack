"use client";

/**
 * The update area of the Machines cards (work-wolfpack-NqEVJAU, split out of pack-machines.tsx): the desktop app block, the console own-machine
 * update banner and auto switch. Rules are in src/core/pack/machine-card.ts.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePackHealth } from "@/components/pack/pack-health";
import { BrailleSpinner } from "@/components/shell/braille-spinner";
import { cn } from "@/lib/utils";
import { useSingleMac } from "@/components/shell/single-mac";
import { useAppBridge } from "@/components/settings/app-bridge";
import { useAppUpdateState } from "@/components/settings/use-app-update-state";
import { failedLine, retryLabel, stageLabel, type UpdateState } from "@wolfpack/protocol/update-state";
import {
	appCheckNote,
	appRestartLabel,
	ageText,
	groupByHost,
	type InventoryRowView,
	logLines,
	machineCard,
	restartSummary,
	sendMachineCommand,
	versionText,
	updateFinished,
	updateOffered,
	updateOutcome,
	updateQuestion,
	UPDATE_READONLY_NOTE,
	type CommandResult,
	type HealthActionsView,
	type HostCard,
	type MachineCardView,
	type MachineServiceView,
	type UpdateUnitView,
} from "@/src/core";


import { MachineCard } from "@/components/pack/pack-machines";

export const BTN = "rounded-sm border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50 max-md:min-h-11 max-md:px-3 max-md:py-2";

/**
 * Single-Mac: the desktop app's own updater (electron-updater downloads in the background and installs on quit). Says so, shows the app
 * version, offers Check now (the app answers with its own dialog) and, once an update is downloaded, Restart to update.
 */
export function AppUpdateBlock({ version, state }: { version: string | null; state?: UpdateState | null }) {
	const bridge = useAppBridge();
	const hooked = useAppUpdateState({ version });
	const stage = state === undefined ? hooked : state;
	const label = stage ? stageLabel(stage) : null;
	const [ready, setReady] = useState<string | null>(null);
	const [checking, setChecking] = useState(false);
	const [note, setNote] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
	useEffect(() => bridge?.onUpdateStatus?.((s) => { if (s.status === "downloaded" && "version" in s && s.version) setReady(s.version); }), [bridge]);
	// `ready` from the seeded state counts too: a window opened after the download gets no legacy push (work-wolfpack-WIaZh5k).
	const restart = appRestartLabel(ready ?? (stage?.state === "ready" ? (stage.latest ?? "") : null)) ?? (stage?.state === "ready" ? "Restart to update" : null);
	return (
		<div data-testid="machine-app-update" className="mt-2 rounded-md border px-2 py-1.5 text-muted-foreground">
			<p data-testid="machine-app-update-note">Updates install by themselves: the app downloads them in the background and asks you to restart.</p>
			<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
				<span data-testid="machine-app-version" className="text-foreground">{version ? `Wolfpack v${version}` : "Wolfpack"}</span>
				<span className="ml-auto flex flex-wrap items-center gap-1.5">
					{restart && <button type="button" data-testid="machine-app-restart" onClick={() => bridge?.installUpdate?.()} className={BTN}>{restart}</button>}
					{bridge?.checkForUpdates && <button type="button" data-testid="machine-app-check" disabled={checking} onClick={() => { setChecking(true); setNote(null); void bridge.checkForUpdates!().then((r) => setNote(appCheckNote(r))).catch(() => setNote(appCheckNote({ ok: false }))).finally(() => setChecking(false)); }} className={BTN}>Check now</button>}
				</span>
			</div>
			{label && (
				<p data-testid="machine-app-stage" className={stage?.state === "failed" ? (stage.error?.quiet ? "mt-1 text-muted-foreground" : "mt-1 text-red-600 dark:text-red-400") : "mt-1 text-foreground"}>
					{stage?.state === "failed" ? failedLine(stage) : label}
				</p>
			)}
			{stage?.state === "failed" && bridge?.checkForUpdates && <button type="button" data-testid="machine-app-retry" disabled={checking} onClick={() => { setChecking(true); setNote(null); void bridge.checkForUpdates!().then((r) => setNote(appCheckNote(r))).catch(() => setNote(appCheckNote({ ok: false }))).finally(() => setChecking(false)); }} className={cn(BTN, "mt-1")}>{retryLabel}</button>}
			{note && <p data-testid={note.tone === "error" ? "machine-app-update-error" : "machine-app-update-ok"} className={note.tone === "error" ? "mt-1 text-red-600 dark:text-red-400" : "mt-1"}>{note.text}</p>}
		</div>
	);
}

/**
 * Another machine's update area (work-wolfpack-NqEVJAU): what its workerd reported (failed reason, installing), Update when a component is behind
 * and Retry when it failed, both sent as update.run through the hub's command channel. A worker without update.run (older) gets the plain
 * "update it from its own console" line and no button. One send at a time (`busy`); a timeout means the outcome is unknown, never resent.
 */
export function RemoteUpdateBlock({ view, note, busy, onRun }: { view: MachineCardView; note?: string; busy: boolean; onRun?: (clearFailed: boolean) => void }) {
	const u = view.update?.kind === "pack" ? view.update : undefined;
	const hs = u?.hostState;
	const failed = hs?.state === "failed";
	const installing = hs?.state === "installing";
	const can = !!u?.canRun && !!onRun;
	const off = busy || !view.online;
	return (
		<>
			{failed && (
				<p data-testid="machine-remote-failed" className="mt-2 text-red-600 dark:text-red-400">{failedLine(hs)}</p>
			)}
			{!can ? (
				<p data-testid="machine-update-readonly" className="mt-2 text-muted-foreground/70">{UPDATE_READONLY_NOTE}</p>
			) : (
				<div data-testid="machine-remote-update" className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
					{installing && <p data-testid="machine-remote-stage" className="text-foreground">{stageLabel(hs)}</p>}
					{failed && <button type="button" data-testid="machine-remote-retry" disabled={off} onClick={() => onRun!(true)} className={BTN}>{retryLabel}</button>}
					{!failed && !installing && u?.behind && <button type="button" data-testid="machine-remote-update-button" disabled={off} onClick={() => onRun!(false)} className={BTN}>Update</button>}
					{busy && <BrailleSpinner className="h-[1.25em]" label="Sending update" />}
					{note && <p data-testid="machine-remote-note" className="text-muted-foreground">{note}</p>}
				</div>
			)}
		</>
	);
}

type Sub = { channel: "stable" | "main"; mode: "off" | "button" | "auto" | "unknown"; exists?: boolean };
type HealthUpdateState = { units: UpdateUnitView[]; last: { result: string; exitStatus: number | null; at: string | null } | null; /** The host updater's failed or installing state. */ updateState?: UpdateState };
type Ui = { phase: "idle" } | { phase: "confirm" } | { phase: "sending" } | { phase: "issued"; at: number } | { phase: "wait"; until: number } | { phase: "error"; message: string };

/**
 * The console's own machine card (work-wolfpack-leOBfgn): the machine card plus the update banner (GET /api/health/update every 15 s, 2 s
 * while an update runs; POST /api/health/update starts it), Check now, and the auto switch. The auto switch and the channel picker share one
 * subscription state and one save (PUT /api/health/subscription, this machine's own file). hubd and the console restart mid-update, so a
 * failed poll shows "reconnecting", not an error. `api`: dev fixtures replace fetch (?healthUpdate=).
 */
export function ConsoleMachineCard({ card, canAct, actions, api, ...rest }: { card: HostCard; canAct: boolean; actions: HealthActionsView | undefined; api?: typeof fetch } & Pick<Parameters<typeof MachineCard>[0], "logs" | "notes" | "busy" | "onRestart" | "onRefreshLog">) {
	const singleMac = useSingleMac();
	const call: typeof fetch = (u, i) => (api ?? fetch)(u, i);
	const label = card.label;
	const [state, setState] = useState<HealthUpdateState | null>(null);
	const [sub, setSub] = useState<Sub | null>(null);
	const [offline, setOffline] = useState(false);
	const [ui, setUi] = useState<Ui>({ phase: "idle" });
	// The run being watched: one this card started (after: the last run seen then) or one it saw running that it did not start.
	const [run, setRun] = useState<{ after: string | null; since: number } | null>(null);
	const [gaveUp, setGaveUp] = useState(false);
	const [saving, setSaving] = useState(false);
	const [subErr, setSubErr] = useState(false);
	const [tick, setTick] = useState(0);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => void (mounted.current = false);
	}, []);
	const [done, setDone] = useState<number | null>(null);
	const [now, setNow] = useState(() => Date.now());
	const [checkNote, setCheckNote] = useState<string | null>(null);
	const [saveErr, setSaveErr] = useState<string | null>(null);
	const serverRunning = state?.last?.result === "running";
	const running = !gaveUp && (ui.phase === "issued" || serverRunning);
	/** `alive`: false once the caller's effect is gone, so an older in-flight read never overwrites newer state. */
	const read = async (refresh: boolean, alive: () => boolean = () => mounted.current) => {
		try {
			// ?refresh=1: the server re-reads the release manifest instead of using its cache.
			const r = await call(refresh ? "/api/health/update?refresh=1" : "/api/health/update", { cache: "no-store" });
			if (!r.ok) throw new Error(String(r.status));
			const b = (await r.json()) as Partial<HealthUpdateState>;
			const next = { units: Array.isArray(b.units) ? b.units : [], last: b.last ?? null, ...(b.updateState ? { updateState: b.updateState } : {}) };
			if (alive()) {
				setState(next);
				setOffline(false);
			}
			return next;
		} catch {
			if (alive()) setOffline(true);
			return null;
		} finally {
			if (alive()) setNow(Date.now());
		}
	};
	useEffect(() => {
		let stop = false;
		const poll = () => void (!stop && read(false, () => !stop));
		poll();
		const t = setInterval(poll, running ? 2_000 : 15_000);
		return () => {
			stop = true;
			clearInterval(t);
		};
	// eslint-disable-next-line react-hooks/exhaustive-deps -- read is rebuilt each render; the poll restarts only when running or api change
	}, [running, api]);
	useEffect(() => {
		let stop = false;
		void call("/api/health/subscription", { cache: "no-store" })
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
			.then((s: Sub) => !stop && (setSub(s), setSubErr(false)))
			.catch(() => !stop && setSubErr(true));
		return () => {
			stop = true;
		};
	// eslint-disable-next-line react-hooks/exhaustive-deps -- one fetch per api; call is rebuilt each render and must not refetch
	}, [api]);
	useEffect(() => {
		// A run the server reports as running that this card did not start (started elsewhere): watch it too, from when it was first seen.
		if (!run && !gaveUp && serverRunning && ui.phase !== "sending") setRun({ after: null, since: Date.now() });
		// After giving up on a stuck "running", the next report that is not running clears the flag.
		if (gaveUp && !serverRunning) setGaveUp(false);
	}, [run, gaveUp, serverRunning, ui.phase]);
	useEffect(() => {
		if (!run || ui.phase === "sending") return;
		const fin = updateFinished(state?.last, run.after, state?.units.length ?? 0);
		if (fin) {
			setRun(null);
			if (fin.ok) return void (setDone(Date.now()), setUi({ phase: "idle" }));
			return void setUi({ phase: "error", message: fin.message });
		}
		if (now - run.since > 600_000) {
			setRun(null);
			setGaveUp(true);
			setUi({ phase: "error", message: "Update failed: No result after 10 minutes." });
		}
	}, [run, ui.phase, state, now]);
	useEffect(() => {
		// 429: count down once a second from the deadline.
		if (ui.phase !== "wait") return;
		if (ui.until - Date.now() <= 0) return void setUi({ phase: "idle" });
		const t = setTimeout(() => setTick((n) => n + 1), 1000);
		return () => clearTimeout(t);
	}, [ui, tick]);
	const send = async (opts: { clearFailed?: boolean } = {}) => {
		setDone(null);
		setGaveUp(false);
		setRun({ after: state?.last?.at ?? null, since: Date.now() });
		setUi({ phase: "sending" });
		let status = 0;
		let retry: string | null = null;
		let body: unknown = null;
		try {
			// One POST per tap, never resent: a 504 is an unknown outcome and the owner decides.
			const r = await call("/api/health/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ service: "update", ...(opts.clearFailed ? { clearFailed: true } : {}) }) });
			status = r.status;
			retry = r.headers.get("Retry-After");
			if (status !== 202) body = await r.json().catch(() => null);
		} catch {
			status = 0;
		}
		const out = updateOutcome(status, retry, body, label);
		if (out.kind === "issued") setUi({ phase: "issued", at: Date.now() });
		else {
			setRun(null);
			// 409 and not "running": the server says nothing is behind, so the banner must not offer an update.
			if (status === 409 && (body as { code?: unknown } | null)?.code !== "running") setState((s) => s && { ...s, units: [] });
			setUi(out.kind === "wait" ? { phase: "wait", until: Date.now() + out.retryS * 1000 } : { phase: "error", message: out.message });
		}
	};
	// Opened from the sidebar notice's "Update now" (work-wolfpack-vkAgw7I): ?update=<machine>:<components>. Once the first update read is in, the
	// param is cleared (a reload must not start it again), and when it names this machine and something is behind, the same send() as the
	// Update button runs, with no confirm step. The row is scrolled to and ringed for a few seconds.
	const arrival = useRef(false);
	const areaRef = useRef<HTMLDivElement>(null);
	const [ring, setRing] = useState(false);
	useEffect(() => {
		if (arrival.current || state === null) return;
		arrival.current = true;
		const params = new URLSearchParams(window.location.search ?? "");
		const want = params.get("update");
		if (want === null) return;
		params.delete("update");
		const qs = params.toString();
		window.history.replaceState(window.history.state, "", (window.location.pathname ?? "") + (qs ? `?${qs}` : "") + (window.location.hash ?? ""));
		const machine = want.split(":")[0];
		if (singleMac || (machine && machine !== card.label && machine !== card.id)) return;
		areaRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
		setRing(true);
		setTimeout(() => mounted.current && setRing(false), 8_000);
		if (canAct && state.units.length > 0) void send();
	// eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, on the first read; send is rebuilt each render
	}, [state]);
	const save = async (patch: Partial<Sub>) => {
		// Not before the subscription is read (the base would be a guess) and not while another save is in flight (reverts and PUTs would cross).
		const prev = sub;
		if (!prev || saving) return;
		const next: Sub = { ...prev, ...patch };
		setSaving(true);
		setSub(next);
		setSaveErr(null);
		try {
			const r = await call("/api/health/subscription", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel: next.channel, mode: next.mode === "unknown" ? "button" : next.mode }) });
			if (!r.ok) throw new Error(String(r.status));
		} catch (e) {
			setSub(prev);
			setSaveErr(`Could not save (${(e as Error).message === "401" ? "sign in first" : "failed"})`);
		} finally {
			if (mounted.current) setSaving(false);
		}
	};
	const check = async () => {
		setCheckNote("Checking…");
		const s = await read(true);
		setCheckNote(!s ? "Could not check for updates" : s.units.length ? null : `Already up to date on ${label}`);
	};
	const units = state?.units ?? [];
	const recentlyDone = done !== null && now - done < 120_000;
	const hostStage = state?.updateState && stageLabel(state.updateState) && (state.updateState.state === "installing" || state.updateState.state === "failed") ? state.updateState : null;
	const showBanner = updateOffered(actions, units) || ui.phase !== "idle" || running || recentlyDone || hostStage !== null;
	const busy = ui.phase === "sending";
	const waitS = ui.phase === "wait" ? Math.max(0, Math.ceil((ui.until - Date.now()) / 1000)) : 0;
	const update = (
		<div data-testid="machine-update-area" ref={areaRef} className={cn("mt-2 rounded-md", ring && "ring-2 ring-teal-400/60 ring-offset-2 ring-offset-background")}>
			{showBanner && (
				<div data-testid="machine-update" className="rounded-md border px-2 py-1.5">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
						{units.length > 0 && <span className="font-medium text-foreground">Update available</span>}
						{units.map((u) => (
							<span key={u.component} className="text-muted-foreground/80">{u.component} {u.from ? `v${u.from}` : "?"} → v{u.to}</span>
						))}
						<span className="ml-auto flex flex-wrap items-center gap-1.5">
							{busy ? (
								<BrailleSpinner className="h-[1.25em]" label="Sending update" />
							) : running ? (
								<span data-testid="machine-update-running" className="flex items-center gap-1.5 text-muted-foreground">
									<BrailleSpinner className="h-[1.25em]" label="Updating" />
									{offline ? "Updating; reconnecting…" : "Updating…"}
								</span>
							) : ui.phase === "confirm" ? (
								<span data-testid="machine-update-confirm" className="flex flex-wrap items-center justify-end gap-1">
									<span className="text-muted-foreground">{updateQuestion(units)}</span>
									<button type="button" onClick={() => setUi({ phase: "idle" })} className={BTN}>Cancel</button>
									<button type="button" data-testid="machine-update-button-confirm" onClick={() => void send()} className={cn(BTN, "border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/20")}>Update</button>
								</span>
							) : ui.phase === "idle" && recentlyDone ? (
								<span data-testid="machine-update-done" className="text-green-600 dark:text-green-400">Updated</span>
							) : ui.phase === "wait" ? (
								<span data-testid="machine-update-wait" className="text-amber-600 dark:text-amber-400">Too many tries · retry in {waitS >= 120 ? `${Math.ceil(waitS / 60)} min` : `${waitS}s`}</span>
							) : (
								<button type="button" data-testid="machine-update-button" disabled={!canAct} onClick={() => setUi({ phase: "confirm" })} className={BTN}>Update</button>
							)}
						</span>
					</div>
					{hostStage && (
						<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
							<p data-testid="machine-host-stage" className={hostStage.state === "failed" ? "text-red-600 dark:text-red-400" : "text-foreground"}>
								{hostStage.state === "failed" ? failedLine(hostStage) : stageLabel(hostStage)}
							</p>
							{hostStage.state === "failed" && !running && !busy && ui.phase === "idle" && (
								<button type="button" data-testid="machine-update-retry" disabled={!canAct} onClick={() => void send({ clearFailed: true })} className={cn(BTN, "ml-auto")}>{retryLabel}</button>
							)}
						</div>
					)}
					{ui.phase === "error" && <p data-testid="machine-update-error" className="mt-1 text-red-600 dark:text-red-400">{ui.message}</p>}
				</div>
			)}
			<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
				<label className="flex items-center gap-2 max-md:min-h-11">
					<input type="checkbox" data-testid="machine-auto-switch" className="max-md:size-5" checked={sub?.mode === "auto"} disabled={!canAct || !sub || saving} onChange={(e) => void save({ mode: e.target.checked ? "auto" : "button" })} />
					<span>Update automatically</span>
				</label>
				<span className="text-muted-foreground/70">wolfd always waits for you</span>
				{sub?.exists === false && sub.mode === "unknown" && <span className="text-muted-foreground/70">not set (host default)</span>}
			</div>
						{saveErr && <p data-testid="machine-save-error" className="mt-1 text-red-600 dark:text-red-400">{saveErr}</p>}
		</div>
	);
	return <MachineCard view={machineCard(card, sub?.channel ?? null, { singleMac, mode: sub?.mode ?? null, readFailed: subErr && !sub })} update={update} checkNote={checkNote} onCheck={() => void check()} channelDisabled={!canAct || !sub || saving} onChannel={(c) => void save({ channel: c })} {...rest} />;
}
