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
import { useSingleMac } from "@/components/shell/single-mac";
import { useAppBridge } from "@/components/settings/app-bridge";
import { useAppUpdateState } from "@/components/settings/use-app-update-state";
import { failedLine, remoteRetryText, retryLabel, stageLabel, type UpdateState } from "@wolfpack/protocol/update-state";
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

import { AppUpdateBlock, BTN, ConsoleMachineCard } from "@/components/pack/machine-update-details";
export { AppUpdateBlock, ConsoleMachineCard };

const TONE: Record<string, string> = { red: "bg-red-500", amber: "bg-amber-500", grey: "bg-muted-foreground/50", green: "bg-emerald-500" };

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
	/** The host's own update state (failed or installing). A failure on a machine without `update` says to open that machine's console to retry. */
	hostUpdate?: UpdateState | null;
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
			{view.update?.kind === "app" && <AppUpdateBlock version={view.update.version} />}
			{view.update?.kind === "pack" && !p.update && p.hostUpdate?.state === "failed" && (
				<p data-testid="machine-remote-failed" className="mt-2 text-red-600 dark:text-red-400">
					{failedLine(p.hostUpdate)}
					<span className="block text-muted-foreground">{remoteRetryText(view.label)}</span>
				</p>
			)}
			{view.update?.kind === "pack" && (p.update ?? <p data-testid="machine-update-readonly" className="mt-2 text-muted-foreground/70">{UPDATE_READONLY_NOTE}</p>)}
			{view.update?.kind === "pack" && <div data-testid="machine-channel" className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
				<span>Update channel</span>
				{view.channel.editable ? (
					<select data-testid="machine-channel-select" disabled={p.channelDisabled} value={view.channel.value ?? "stable"} onChange={(e) => p.onChannel?.(e.target.value as "stable" | "main")} className="rounded-sm border bg-background px-2 py-1 max-md:min-h-11">
						<option value="stable">stable</option>
						<option value="main">main (testing)</option>
					</select>
				) : (
					<span data-testid="machine-channel-value" className="rounded-sm border px-1.5 text-foreground">{view.channel.value ?? view.channel.missing ?? "unknown"}{view.channel.mode ? ` · ${view.channel.mode}` : ""}</span>
				)}
				{view.channel.editable && view.channel.mode && <span data-testid="machine-mode" className="text-foreground">· {view.channel.mode}</span>}
				{view.channel.note && <span className="text-muted-foreground/70">{view.channel.note}</span>}
				{p.onCheck && <button type="button" data-testid="machine-check" onClick={p.onCheck} className={cn(BTN, "ml-auto")}>Check now</button>}
			</div>}
			{view.update?.kind === "pack" && p.checkNote && <p data-testid="machine-check-note" className="mt-1 text-muted-foreground">{p.checkNote}</p>}
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
				<span data-testid="machine-service-version" className="text-muted-foreground">{versionText(s.version, s.versionNote)}</span>
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
							<span className="text-muted-foreground">{versionText(w.version, w.versionNote)}</span>
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

/** The Machines section body. */
export function MachinesSection() {
	const { snapshot, reachable, lastSeenAt, now } = usePackHealth();
	const singleMac = useSingleMac();
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
	const views = cards.map((c) => machineCard(c, null, { singleMac })); // the channel only matters for display; the own card builds its own view
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
