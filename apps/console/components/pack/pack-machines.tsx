"use client";

/**
 * PACK > MACHINES (work-wolfpack-4qae7Hg): one card per machine, from the shared health snapshot (usePackHealth) and the hub command
 * channel (sendMachineCommand). Rules are in src/core/pack/machine-card.ts. Restart is per down service (Wolf runtime → wolves.restart, Background service → workerd.restart) and only when the machine advertised it; never the hub.
 * Log lines of a down service come from logs.fetch and are shown as sent. The update channel is read from the machine's own subscription
 * file through this console's /api/health/subscription (own machine only; other machines show it read-only).
 *   dev: ?machineCmd=ok|unsupported|offline|timeout answers every command from a fake (no hub call); not in production.
 */
import { useCallback, useEffect, useState } from "react";
import { usePackHealth } from "@/components/pack/pack-health";
import { cn } from "@/lib/utils";
import {
	ageText,
	groupByHost,
	logLines,
	machineCard,
	restartSummary,
	sendMachineCommand,
	type CommandResult,
	type MachineCardView,
	type MachineServiceView,
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
			<div data-testid="machine-channel" className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
				<span>Update channel</span>
				{view.channel.editable ? (
					<select data-testid="machine-channel-select" value={view.channel.value ?? "stable"} onChange={(e) => p.onChannel?.(e.target.value as "stable" | "main")} className="rounded-sm border bg-background px-2 py-1 max-md:min-h-11">
						<option value="stable">stable</option>
						<option value="main">main (testing)</option>
					</select>
				) : (
					<span data-testid="machine-channel-value" className="rounded-sm border px-1.5 text-foreground">{view.channel.value ?? "unknown"}</span>
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
				<span data-testid="machine-service-version" className="text-muted-foreground">{s.version ? `v${s.version}` : "version unknown"}</span>
				{onRefresh && <button type="button" data-testid="machine-log-refresh" onClick={onRefresh} className={cn(BTN, "ml-auto")}>Refresh log</button>}
				{s.restart && (
					<button type="button" data-testid="machine-restart" data-for={s.kind} disabled={busy} onClick={onRestart} className={cn(BTN, onRefresh ? "" : "ml-auto")}>{busy ? "Restarting…" : "Restart"}</button>
				)}
			</div>
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

type Sub = { channel: "stable" | "main"; mode: string };

/** The Machines section body. */
export function MachinesSection() {
	const { snapshot, reachable, lastSeenAt, now } = usePackHealth();
	const [send, setSend] = useState<Send>(() => sendMachineCommand);
	const [sub, setSub] = useState<Sub | null>(null);
	const [logs, setLogs] = useState<Record<string, Record<string, LogState>>>({});
	const [notes, setNotes] = useState<Record<string, string>>({});
	const [checks, setChecks] = useState<Record<string, string>>({});
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
	useEffect(() => {
		let stop = false;
		void fetch("/api/health/subscription", { cache: "no-store" })
			.then((r) => (r.ok ? r.json() : null))
			.then((s: Sub | null) => !stop && s && setSub(s))
			.catch(() => {});
		return () => {
			stop = true;
		};
	}, []);
	const cards = snapshot ? groupByHost(snapshot).filter((c) => c.checked) : [];
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
	const views = cards.map((c) => machineCard(c, c.console ? (sub?.channel ?? null) : null));
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
	const check = async (id: string, label: string) => {
		setChecks((c) => ({ ...c, [id]: "Checking…" }));
		try {
			// ?refresh=1: the server re-reads the release manifest instead of using its cache.
			const r = await fetch("/api/health/update?refresh=1", { cache: "no-store" });
			const b = (await r.json()) as { units?: { component: string; to: string }[] };
			const u = b.units ?? [];
			setChecks((c) => ({ ...c, [id]: u.length ? `Update available: ${u.map((x) => `${x.component} v${x.to}`).join(", ")}` : `Already up to date on ${label}` }));
		} catch {
			setChecks((c) => ({ ...c, [id]: "Could not check for updates" }));
		}
	};
	const setChannel = async (c: "stable" | "main") => {
		const prev = sub;
		const next: Sub = { channel: c, mode: prev?.mode === "unknown" || !prev ? "button" : prev.mode };
		setSub(next);
		try {
			const r = await fetch("/api/health/subscription", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
			if (!r.ok) throw new Error(String(r.status));
		} catch {
			setSub(prev);
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
				views.map((v, i) => (
					<MachineCard
						key={v.id}
						view={v}
						logs={logs[v.id] ?? {}}
						notes={Object.fromEntries(Object.entries(notes).filter(([k]) => k.startsWith(`${v.id}/`)).map(([k, t]) => [k.slice(v.id.length + 1), t]))}
						busy={new Set([...busy].filter((k) => k.startsWith(`${v.id}/`)).map((k) => k.slice(v.id.length + 1)))}
						checkNote={checks[v.id]}
						onRestart={(s) => void restart(v, s)}
						onCheck={cards[i]!.console ? () => void check(v.id, v.label) : undefined}
						onRefreshLog={(s) => void fetchLog(v.id, s)}
						onChannel={(c) => void setChannel(c)}
					/>
				))
			)}
		</div>
	);
}
