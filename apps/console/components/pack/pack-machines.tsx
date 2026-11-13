"use client";

/**
 * PACK > MACHINES (work-wolfpack-4qae7Hg): one card per machine, from the shared health snapshot (usePackHealth) and the hub command
 * channel (sendMachineCommand). Rules are in src/core/pack/machine-card.ts. Restart is per down service (Wolf runtime → wolves.restart, Background service → workerd.restart) and only when the machine advertised it; never the hub.
 * Log lines of a down service come from logs.fetch and are shown as sent. The update channel is read from the machine's own subscription
 * file through this console's /api/health/subscription (own machine only; other machines show it read-only).
 *   dev: ?machineCmd=ok|unsupported|offline|timeout answers every command from a fake (no hub call); not in production.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePackHealth } from "@/components/pack/pack-health";
import { BrailleSpinner } from "@/components/shell/braille-spinner";
import { cn } from "@/lib/utils";
import {
	ageText,
	groupByHost,
	type InventoryRowView,
	logLines,
	machineCard,
	restartSummary,
	sendMachineCommand,
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

const TONE: Record<string, string> = { red: "bg-red-500", amber: "bg-amber-500", grey: "bg-muted-foreground/50", green: "bg-emerald-500" };
const BTN = "rounded-sm border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50 max-md:min-h-11 max-md:px-3 max-md:py-2";

export type Send = (hostId: string, cmd: { kind: string; args?: unknown }) => Promise<CommandResult>;
export type LogState = { lines: string[]; error: string | null } | "loading";

/** Dev fake for ?machineCmd=<outcome>. */
export function fakeSend(outcome: string): Send {
	return async (_h, cmd) => {
		if (outcome === "unsupported") return { id: "c-fake", ok: false, code: "not_sent_unsupported" };
		if (outcome === "offline") return { id: "c-fake", ok: false, code: "not_sent_offline" };
		if (outcome === "timeout") return { id: "c-fake", ok: false, code: "timeout" };
		if (cmd.kind === "logs.fetch") return { id: "c-fake", ok: true, data: { lines: ["Nov 12 10:01:02 host workerd[812]: link closed: ECONNREFUSED", "Nov 12 10:01:03 host workerd[812]: retry in 5s"], truncated: false } };
		return { id: "c-fake", ok: true, message: cmd.kind === "workerd.restart" ? "restarting; the machine will reconnect" : "restarted, but could not confirm" };
	};
}

/** The presentational card. `logs`: fetched lines by log service; `notes`: the last restart line by service kind; `busy`: the service kinds being restarted. */
export function MachineCard(p: {
	view: MachineCardView;
	logs: Record<string, LogState>;
	notes?: Record<string, string>;
	busy?: ReadonlySet<string>;
	checkNote?: string | null;
	onRestart?: (service: MachineServiceView) => void;
	onCheck?: () => void;
	onRefreshLog?: (service: string) => void;
	onChannel?: (c: "stable" | "main") => void;
	/** The channel picker is disabled while a subscription save is in flight. */
	channelDisabled?: boolean;
	/** The update banner and the auto switch (the console's own machine only); other machines say where to update. */
	update?: ReactNode;
}) {
	const { view } = p;
	return (
		<section data-testid="machine-card" data-machine={view.id} data-online={view.online} className="mb-3 rounded-lg border bg-card px-3 py-2">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<span aria-hidden className={cn("size-2 rounded-full", view.online ? TONE.green : TONE.red)} />
				<h3 className="font-medium text-foreground">{view.label}</h3>
				<span data-testid="machine-online" className={view.online ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>{view.online ? "Online" : "Offline"}</span>
			</div>
			{!view.online && <p data-testid="machine-offline-note" className="mt-1 text-muted-foreground">Nothing can be sent to it until it is back online.</p>}
			<ul className="mt-2 flex flex-col gap-1">
				{view.services.map((s) => (
					<ServiceRow key={s.kind} s={s} note={p.notes?.[s.kind]} busy={p.busy?.has(s.kind) ?? false} onRestart={() => p.onRestart?.(s)} log={s.logService ? p.logs[s.logService] : undefined} onRefresh={s.logService && view.online ? () => p.onRefreshLog?.(s.logService!) : undefined} />
				))}
			</ul>
			{p.update ?? <p data-testid="machine-update-readonly" className="mt-2 text-muted-foreground/70">{UPDATE_READONLY_NOTE}</p>}
			<div data-testid="machine-channel" className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
				<span>Update channel</span>
				{view.channel.editable ? (
					<select data-testid="machine-channel-select" disabled={p.channelDisabled} value={view.channel.value ?? "stable"} onChange={(e) => p.onChannel?.(e.target.value as "stable" | "main")} className="rounded-sm border bg-background px-2 py-1 max-md:min-h-11">
						<option value="stable">stable</option>
						<option value="main">main (testing)</option>
					</select>
				) : (
					<span data-testid="machine-channel-value" className="rounded-sm border px-1.5 text-foreground">{view.channel.value ?? view.channel.missing ?? "unknown"}</span>
				)}
				{view.channel.note && <span className="text-muted-foreground/70">{view.channel.note}</span>}
				{p.onCheck && <button type="button" data-testid="machine-check" onClick={p.onCheck} className={cn(BTN, "ml-auto")}>Check now</button>}
			</div>
			{p.checkNote && <p data-testid="machine-check-note" className="mt-1 text-muted-foreground">{p.checkNote}</p>}
		</section>
	);
}

function ServiceRow({ s, log, note, busy, onRestart, onRefresh }: { s: MachineServiceView; log?: LogState; note?: string; busy?: boolean; onRestart?: () => void; onRefresh?: () => void }) {
	return (
		<li data-testid="machine-service" data-service={s.kind} data-down={s.down} className="rounded-md border px-2 py-1.5">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<span aria-hidden className={cn("size-2 rounded-full", TONE[s.tone])} />
				<span className="text-foreground">{s.label}{s.count && s.count > 1 ? ` (${s.count})` : ""}</span>
				<span data-testid="machine-service-status" className="text-muted-foreground">{s.status === "ok" ? "running" : s.down ? "down" : s.status}</span>
				<span data-testid="machine-service-version" className="text-muted-foreground">{s.version ? `v${s.version}` : (s.versionNote ?? "version unknown")}</span>
				{onRefresh && <button type="button" data-testid="machine-log-refresh" onClick={onRefresh} className={cn(BTN, "ml-auto")}>Refresh log</button>}
				{s.restart && (
					<button type="button" data-testid="machine-restart" data-for={s.kind} disabled={busy} onClick={onRestart} className={cn(BTN, onRefresh ? "" : "ml-auto")}>{busy ? "Restarting…" : "Restart"}</button>
				)}
			</div>
			{s.wolves && s.wolves.length > 0 && (
				<ul data-testid="machine-wolves" className="mt-1 space-y-0.5 pl-4 text-xs">
					{s.wolves.map((w) => (
						<li key={`${s.kind}:${w.name}`} data-testid="machine-wolf" data-wolf={w.name} className="flex flex-wrap items-center gap-x-2">
							<span aria-hidden className={cn("size-1.5 rounded-full", TONE[w.tone])} />
							<span className="text-foreground">{w.name}</span>
							<span className="text-muted-foreground">{w.status === "ok" ? "running" : w.tone === "red" ? "down" : w.status === "unknown" ? "not reporting" : w.status}</span>
							<span className="text-muted-foreground">{w.version ? `v${w.version}` : (w.versionNote ?? "version unknown")}</span>
						</li>
					))}
				</ul>
			)}
			{s.hint && <p data-testid="machine-restart-hint" className="mt-1 text-muted-foreground">{s.hint}</p>}
			{note && <p data-testid="machine-service-note" className="mt-1 text-muted-foreground">{note}</p>}
			{s.down && log !== undefined && (
				<div data-testid="machine-log" className="mt-1">
					{log === "loading" ? (
						<p className="text-muted-foreground">Fetching log lines…</p>
					) : log.error ? (
						<p data-testid="machine-log-error" className="text-muted-foreground">{log.error}</p>
					) : (
						<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-muted/40 p-2 text-xs">{log.lines.length ? log.lines.join("\n") : "No log lines."}</pre>
					)}
				</div>
			)}
		</li>
	);
}

type Sub = { channel: "stable" | "main"; mode: "off" | "button" | "auto" | "unknown"; exists?: boolean };
type UpdateState = { units: UpdateUnitView[]; last: { result: string; exitStatus: number | null; at: string | null } | null };
type Ui = { phase: "idle" } | { phase: "confirm" } | { phase: "sending" } | { phase: "issued"; at: number } | { phase: "wait"; until: number } | { phase: "error"; message: string };

/**
 * The console's own machine card (work-wolfpack-leOBfgn): the machine card plus the update banner (GET /api/health/update every 15 s, 2 s
 * while an update runs; POST /api/health/update starts it), Check now, and the auto switch. The auto switch and the channel picker share one
 * subscription state and one save (PUT /api/health/subscription, this machine's own file). hubd and the console restart mid-update, so a
 * failed poll shows "reconnecting", not an error. `api`: dev fixtures replace fetch (?healthUpdate=).
 */
export function ConsoleMachineCard({ card, canAct, actions, api, ...rest }: { card: HostCard; canAct: boolean; actions: HealthActionsView | undefined; api?: typeof fetch } & Pick<Parameters<typeof MachineCard>[0], "logs" | "notes" | "busy" | "onRestart" | "onRefreshLog">) {
	const call: typeof fetch = (u, i) => (api ?? fetch)(u, i);
	const label = card.label;
	const [state, setState] = useState<UpdateState | null>(null);
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
			const b = (await r.json()) as Partial<UpdateState>;
			const next = { units: Array.isArray(b.units) ? b.units : [], last: b.last ?? null };
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
			setUi({ phase: "error", message: "No result from the update after 10 min — see Logs" });
		}
	}, [run, ui.phase, state, now]);
	useEffect(() => {
		// 429: count down once a second from the deadline.
		if (ui.phase !== "wait") return;
		if (ui.until - Date.now() <= 0) return void setUi({ phase: "idle" });
		const t = setTimeout(() => setTick((n) => n + 1), 1000);
		return () => clearTimeout(t);
	}, [ui, tick]);
	const send = async () => {
		setDone(null);
		setGaveUp(false);
		setRun({ after: state?.last?.at ?? null, since: Date.now() });
		setUi({ phase: "sending" });
		let status = 0;
		let retry: string | null = null;
		let body: unknown = null;
		try {
			// One POST per tap, never resent: a 504 is an unknown outcome and the owner decides.
			const r = await call("/api/health/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ service: "update" }) });
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
	const showBanner = updateOffered(actions, units) || ui.phase !== "idle" || running || recentlyDone;
	const busy = ui.phase === "sending";
	const waitS = ui.phase === "wait" ? Math.max(0, Math.ceil((ui.until - Date.now()) / 1000)) : 0;
	const update = (
		<div data-testid="machine-update-area" className="mt-2">
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
			{subErr && !sub && <p data-testid="machine-sub-error" className="mt-1 text-red-600 dark:text-red-400">Could not read this machine's update settings</p>}
			{saveErr && <p data-testid="machine-save-error" className="mt-1 text-red-600 dark:text-red-400">{saveErr}</p>}
		</div>
	);
	return <MachineCard view={machineCard(card, sub?.channel ?? null)} update={update} checkNote={checkNote} onCheck={() => void check()} channelDisabled={!canAct || !sub || saving} onChannel={(c) => void save({ channel: c })} {...rest} />;
}

/** The Machines section body. */
export function MachinesSection() {
	const { snapshot, reachable, lastSeenAt, now } = usePackHealth();
	const [send, setSend] = useState<Send>(() => sendMachineCommand);
	// dev: ?healthUpdate= / ?healthAuto= replace the update and subscription routes with a fake (pack-health-fixtures.ts); until it loads, nothing is fetched.
	const fakeWanted = typeof window !== "undefined" && process.env.NODE_ENV !== "production" && /[?&]health(Update|Auto)=/.test(window.location.search);
	const [updateApi, setUpdateApi] = useState<typeof fetch | undefined>(() => (fakeWanted ? ((() => new Promise<Response>(() => {})) as typeof fetch) : undefined));
	useEffect(() => {
		if (fakeWanted) void import("@/components/pack/pack-health-fixtures").then((f) => setUpdateApi(() => f.fixtureUpdateApi(window.location.search) ?? undefined));
	}, [fakeWanted]);
	const [logs, setLogs] = useState<Record<string, Record<string, LogState>>>({});
	const [notes, setNotes] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
	const setBusyKey = (key: string, on: boolean) =>
		setBusy((b) => {
			const n = new Set(b);
			if (on) n.add(key);
			else n.delete(key);
			return n;
		});
	useEffect(() => {
		const fake = process.env.NODE_ENV !== "production" ? new URLSearchParams(window.location.search).get("machineCmd") : null;
		if (fake) setSend(() => fakeSend(fake));
	}, []);
	// The hub inventory is read with THIS browser's sign-in (the app's fetch wrapper adds the stored bearer), not a console token.
	type Inv = { state: "ok" | "unavailable" | "signed-out"; rows?: InventoryRowView[]; hubMachine?: string | null };
	const [inv, setInv] = useState<Inv | null>(null);
	useEffect(() => {
		if (fakeWanted) return;
		const ac = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		// One poll at a time: the next is scheduled after the previous settles; unmount aborts the one in flight.
		const load = async () => {
			let next: Inv = { state: "unavailable" };
			try {
				const r = await fetch("/api/health/inventory", { cache: "no-store", signal: ac.signal });
				const b = (await r.json()) as Inv;
				if (r.ok && (b.state === "ok" || b.state === "signed-out")) next = b;
			} catch {
				/* unavailable */
			}
			if (ac.signal.aborted) return;
			setInv(next);
			timer = setTimeout(() => void load(), 5_000);
		};
		void load();
		return () => {
			ac.abort();
			clearTimeout(timer);
		};
	}, [fakeWanted]);
	// Before the first per-viewer answer the cards show a neutral "loading" note, never snapshot data or "version unknown".
	const merged = snapshot ? { ...snapshot, inventory: inv ? { state: inv.state, rows: inv.state === "ok" ? (inv.rows ?? []) : [], stale: false, hubMachine: inv.hubMachine ?? null } : { state: "loading" as const, rows: [], stale: false, hubMachine: null } } : snapshot;
	const cards = merged ? groupByHost(merged).filter((c) => c.checked) : [];
	const hubIdOf = useCallback((id: string) => snapshot?.hosts?.find((h) => h.id === id)?.hubId, [snapshot]);
	const fetchLog = useCallback(
		async (cardId: string, service: string) => {
			const hubId = hubIdOf(cardId);
			if (!hubId) return; // the hub does not list this machine: nothing can be sent
			setLogs((l) => ({ ...l, [cardId]: { ...l[cardId], [service]: "loading" } }));
			const r = await send(hubId, { kind: "logs.fetch", args: { service, lines: 50 } });
			setLogs((l) => ({ ...l, [cardId]: { ...l[cardId], [service]: logLines(r) } }));
		},
		[send, hubIdOf],
	);
	const views = cards.map((c) => machineCard(c, null)); // the channel only matters for display; the own card builds its own view
	const downKey = views.map((v) => (v.online ? v.services.filter((s) => s.logService).map((s) => `${v.id}/${s.logService}`) : []).flat()).flat().join(",");
	useEffect(() => {
		for (const k of downKey ? downKey.split(",") : []) {
			const [id, service] = k.split("/");
			void fetchLog(id!, service!);
		}
	}, [downKey, fetchLog]);
	const restart = async (v: MachineCardView, s: MachineServiceView) => {
		const hubId = hubIdOf(v.id);
		if (!s.restart || !hubId) return;
		const key = `${v.id}/${s.kind}`;
		setBusyKey(key, true);
		try {
			const r = await send(hubId, { kind: s.restart, args: {} });
			setNotes((n) => ({ ...n, [key]: restartSummary(r) }));
		} finally {
			setBusyKey(key, false);
		}
	};
	return (
		<div data-testid="pack-machines">
			{!reachable && (
				<p data-testid="pack-health-unreachable" className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-red-700 dark:text-red-300">
					This console's server is not answering. The cards below are its last report{lastSeenAt !== null ? ` (${ageText(now - lastSeenAt)})` : ""}.
				</p>
			)}
			{snapshot === null ? (
				<p className="text-muted-foreground">{reachable ? "Checking the pack…" : "No report yet."}</p>
			) : (
				views.map((v, i) => {
					const shared = {
						logs: logs[v.id] ?? {},
						notes: Object.fromEntries(Object.entries(notes).filter(([k]) => k.startsWith(`${v.id}/`)).map(([k, t]) => [k.slice(v.id.length + 1), t])),
						busy: new Set([...busy].filter((k) => k.startsWith(`${v.id}/`)).map((k) => k.slice(v.id.length + 1))),
						onRestart: (s: MachineServiceView) => void restart(v, s),
						onRefreshLog: (s: string) => void fetchLog(v.id, s),
					};
					return cards[i]!.console ? (
						<ConsoleMachineCard key={v.id} card={cards[i]!} canAct={reachable} actions={snapshot.actions} api={updateApi} {...shared} />
					) : (
						<MachineCard key={v.id} view={v} {...shared} />
					);
				})
			)}
		</div>
	);
}
