"use client";

/**
 * The Keys section of the Pack panel (work-wolfpack-6EmU8pu): a grid (provider rows x machine columns, grouped Chat / Dictation / Memory)
 * and an editor that seals the pasted key in the browser to each machine's public key and sends it through the hub.
 * The console never sees a key. Only checkKeyShape runs here; the provider check runs on the machine.
 * dev: ?packFixture=keys | keys-env-shadow | keys-rejected | keys-timeout | keys-subscription (components/pack/pack-keys-fixtures.ts).
 */
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
	apiWolves,
	buildGrid,
	checkKeyShape,
	newCommandId,
	pickerOptions,
	sealKeyFor,
	sealSupport,
	sendMachineCommand,
	type CommandResult,
	type KeyMachine,
} from "@/src/core";

type Send = typeof sendMachineCommand;
type Load = () => Promise<{ machines: KeyMachine[] } | { error: string }>;

const BTN = "rounded-sm border px-2.5 py-1 text-xs transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50 max-md:px-3 max-md:py-2";
const INPUT = "w-full rounded-sm border bg-background px-2 py-1 font-mono text-xs max-md:py-2 max-md:text-base";

const liveLoad: Load = async () => {
	try {
		const r = await fetch("/api/pack/machines/keys"); // looked up per call: withHubAuth adds the device token
		const b = (await r.json()) as { machines?: KeyMachine[]; error?: string };
		return r.ok && b.machines ? { machines: b.machines } : { error: b.error ?? `The console answered ${r.status}.` };
	} catch {
		return { error: "This console's server is not answering." };
	}
};

export type MachineOutcome = { state: "idle" | "sending" } | { state: "done"; result: CommandResult };

/** Plain words for one machine's result. A 504 (timeout) means the outcome is unknown: never resent automatically. */
export function outcomeText(r: CommandResult, slot?: string): { tone: "ok" | "bad" | "unknown"; text: string } {
	if (r.ok) {
		const restarted = (r.data as { restarted?: { wolf: string; midReply: boolean }[] } | undefined)?.restarted ?? [];
		const names = restarted.map((w) => (w.midReply ? `${w.wolf} (was mid-reply)` : w.wolf));
		return { tone: "ok", text: names.length ? `Saved. Restarted ${names.join(", ")}.` : slot === "anthropic" ? "Saved. No wolf on this machine uses it; the hub's memory picks it up after the hub restarts." : "Saved." };
	}
	if (r.code === "timeout") return { tone: "unknown", text: "No answer in time. The key may or may not have been saved." };
	if (r.code === "rejected_key") return { tone: "bad", text: `The provider rejected this key: ${r.message ?? "no reason given"}. The old key is kept.` };
	if (r.code === "replay") return { tone: "bad", text: r.message ?? "Refused as a replay." };
	if (r.code === "bad_seal") return { tone: "bad", text: "The machine could not open the sealed key. Reload and try again." };
	if (r.code?.startsWith("not_sent")) return { tone: "bad", text: `Not sent: ${r.message ?? "the machine is not reachable"}.` };
	return { tone: "bad", text: r.message ?? "That did not work." };
}

export function KeyEditor(props: {
	slot: string;
	providerName: string;
	machines: KeyMachine[];
	support: { ok: true } | { ok: false; message: string };
	send: Send;
	onClose: () => void;
	onDone: () => void;
}) {
	const { slot, machines, support } = props;
	// A machine whose key changed is never sealed to until the owner accepts the new key.
	const targets = machines.filter((m) => m.canSetKeys && m.pubkey && !m.keyChanged);
	const [value, setValue] = useState("");
	const [picked, setPicked] = useState<string[]>(() => targets.map((m) => m.hostId));
	const [out, setOut] = useState<Record<string, MachineOutcome>>({});
	const shape = value ? checkKeyShape(slot, value) : null;
	const busy = Object.values(out).some((o) => o.state === "sending");
	// Only the Anthropic key reaches wolves, and only API-key wolves: subscription wolves are neither restarted nor warned about.
	const restarting = slot === "anthropic" ? machines.filter((m) => picked.includes(m.hostId)).flatMap((m) => apiWolves(m).map((w) => ({ w, m }))) : [];
	const midReply = restarting.filter(({ w, m }) => (m.midReply ?? []).includes(w)).map(({ w, m }) => `${w} on ${m.machine}`);

	const sendTo = useCallback(
		async (m: KeyMachine, action: "set" | "remove") => {
			if (action === "set" && m.keyChanged) return;
			setOut((o) => ({ ...o, [m.hostId]: { state: "sending" } }));
			let result: CommandResult;
			try {
				if (action === "remove") result = await props.send(m.hostId, { kind: "key.remove", args: { slot } });
				else {
					const id = newCommandId();
					const sealed = await sealKeyFor({ pubkey: m.pubkey!, hostId: m.hostId, cmdId: id, slot, key: value.trim() });
					result = await props.send(m.hostId, { kind: "key.set", args: { slot }, sealed, id });
				}
			} catch {
				result = { id: "", ok: false, code: "internal", message: "Could not reach the console." };
			}
			setOut((o) => ({ ...o, [m.hostId]: { state: "done", result } }));
			if (result.ok && action === "set") setValue(""); // the key does not linger in the field after it was sent
			if (result.ok) props.onDone();
		},
		[props, slot, value],
	);

	if (!support.ok) {
		return (
			<div data-testid="keys-editor" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
				<p data-testid="keys-no-x25519">{support.message}</p>
				<button type="button" className={cn(BTN, "mt-2")} onClick={props.onClose}>Close</button>
			</div>
		);
	}
	return (
		<div data-testid="keys-editor" className="flex flex-col gap-3 rounded-md border p-3 text-xs">
			<div className="flex items-center justify-between">
				<p className="font-medium text-foreground">{props.providerName} key</p>
				<button type="button" className={BTN} onClick={props.onClose}>Close</button>
			</div>
			<input aria-label={`${props.providerName} key`} type="password" autoComplete="off" spellCheck={false} className={INPUT} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Paste the key" />
			{shape && !shape.ok ? <p data-testid="keys-shape" className="text-destructive">{shape.reason}</p> : shape ? <p className="text-emerald-600">Looks right. The machine checks it with {props.providerName} before saving.</p> : null}
			<p className="text-muted-foreground">Sealed in transit: the console and the hub can&apos;t read it on the way.</p>
			<ul className="flex flex-col gap-1.5">
				{machines.map((m) => {
					const o = out[m.hostId];
					const text = o?.state === "done" ? outcomeText(o.result, slot) : null;
					const can = m.canSetKeys && !!m.pubkey;
					const has = m.slots.find((s) => s.slot === slot)?.source === "pack";
					return (
						<li key={m.hostId} data-testid={`keys-target-${m.hostId}`} className="flex flex-wrap items-center gap-2">
							<label className="flex items-center gap-1.5">
								<input type="checkbox" disabled={!can || !!m.keyChanged} checked={picked.includes(m.hostId)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, m.hostId] : p.filter((x) => x !== m.hostId)))} />
								{m.machine}
							</label>
							{!can ? <span className="text-muted-foreground">can&apos;t take keys (update its workerd)</span> : null}
							{m.keyChanged ? <span className="text-amber-600">its key changed</span> : null}
							{o?.state === "sending" ? <span className="text-muted-foreground">Sending…</span> : null}
							{text ? <span data-testid={`keys-result-${m.hostId}`} className={text.tone === "ok" ? "text-emerald-600" : text.tone === "unknown" ? "text-amber-600" : "text-destructive"}>{text.text}</span> : null}
							{o?.state === "done" && o.result.code === "timeout" ? <button type="button" className={BTN} disabled={!value} onClick={() => void sendTo(m, "set")}>Retry</button> : null}
							{has ? <button type="button" className={BTN} disabled={busy} onClick={() => void sendTo(m, "remove")}>Remove from {m.machine}</button> : null}
							{has ? <span className="text-muted-foreground">If this machine&apos;s environment sets a key, it falls back to the environment key.</span> : null}
						</li>
					);
				})}
			</ul>
			{slot === "anthropic" ? <p data-testid="keys-restarts" className="text-muted-foreground">{restarting.length ? `Saving restarts ${restarting.map(({ w, m }) => `${w} on ${m.machine}`).join(", ")}.` : "Saving restarts no wolves (subscription wolves never use this key)."}</p> : null}
			{midReply.length ? <p data-testid="keys-midreply" className="text-amber-600">Saving restarts the wolves that use this key. Mid-reply right now: {midReply.join(", ")}. They will be cut off.</p> : null}
			<div>
				<button
					type="button"
					className={BTN}
					disabled={busy || !value || !shape?.ok || picked.length === 0}
					onClick={() => void Promise.all(machines.filter((m) => picked.includes(m.hostId)).map((m) => sendTo(m, "set")))}
				>
					Send sealed to {picked.length} machine{picked.length === 1 ? "" : "s"}
				</button>
			</div>
		</div>
	);
}

const cellText = (c: ReturnType<typeof buildGrid>[number]["rows"][number]["cells"][number]): string =>
	c.state === "unknown" ? "—" : c.state === "subscription" ? "Claude subscription" : c.state === "none" ? (c.missing ? "Needs a key" : "—") : `${c.masked ?? "set"} · ${c.state === "env" ? "environment" : "Pack"}${c.state === "shadowed" ? " (overrides environment)" : ""}`;

export function KeysView(props: { machines: KeyMachine[]; support: { ok: true } | { ok: false; message: string }; send: Send; reload: () => void; ack?: (hostId: string, fingerprint: string) => void }) {
	const [editing, setEditing] = useState<{ slot: string; name: string } | null>(null);
	const [picker, setPicker] = useState(false);
	const grid = buildGrid(props.machines);
	const options = pickerOptions(grid);
	return (
		<div data-testid="pack-keys" className="flex flex-col gap-3 text-xs">
			{props.machines.filter((m) => m.keyChanged).map((m) => (
				<p key={m.hostId} data-testid={`keys-changed-${m.hostId}`} className="rounded-sm border border-amber-500/40 bg-amber-500/10 p-2">
					{m.machine}&apos;s key changed (now {m.fingerprint}). Check it&apos;s the same machine before sending keys.{" "}
					{props.ack ? <button type="button" className={BTN} onClick={() => props.ack!(m.hostId, m.fingerprint ?? "")}>It&apos;s expected</button> : null}
				</p>
			))}
			<table className="w-full border-collapse">
				<thead>
					<tr><th className="p-1 text-left font-normal text-muted-foreground" />{props.machines.map((m) => <th key={m.hostId} className="p-1 text-left font-medium">{m.machine}</th>)}</tr>
				</thead>
				{grid.map((g) => (
					<tbody key={g.capability} data-testid={`keys-group-${g.capability}`}>
						<tr><td colSpan={props.machines.length + 1} className="pt-3 text-[11px] uppercase tracking-wide text-muted-foreground">{g.label}</td></tr>
						{g.rows.map((r) => (
							<tr key={r.slot} className="border-t">
								<td className="p-1"><button type="button" className="underline-offset-2 hover:underline" onClick={() => setEditing({ slot: r.slot, name: r.name })}>{r.name}</button></td>
								{r.cells.map((c) => <td key={c.hostId} data-testid={`keys-cell-${g.capability}-${r.slot}-${c.hostId}`} title={c.note} className={cn("p-1", c.missing && "text-destructive", (c.state === "unknown" || c.state === "subscription") && "text-muted-foreground")}>{cellText(c)}</td>)}
							</tr>
						))}
					</tbody>
				))}
			</table>
			<div className="relative">
				<button type="button" className={BTN} onClick={() => setPicker((p) => !p)}>+ Add a provider key</button>
				{picker ? (
					<div data-testid="keys-picker" className="mt-1 rounded-md border p-2">
						{options.length === 0 ? <p className="text-muted-foreground">Every provider is already in the grid.</p> : null}
						{options.map((o) => (
							<div key={o.capability}>
								<p className="text-[11px] uppercase tracking-wide text-muted-foreground">{o.label}</p>
								{o.providers.map((p) => <button key={p.slot} type="button" className="block py-1 hover:underline" onClick={() => (setEditing({ slot: p.slot, name: p.name }), setPicker(false))}>{p.name}</button>)}
							</div>
						))}
					</div>
				) : null}
			</div>
			{editing ? <KeyEditor key={editing.slot} slot={editing.slot} providerName={editing.name} machines={props.machines} support={props.support} send={props.send} onClose={() => setEditing(null)} onDone={props.reload} /> : null}
		</div>
	);
}

export function KeysBody() {
	const [state, setState] = useState<{ machines: KeyMachine[] } | { error: string } | null>(null);
	const [support, setSupport] = useState<{ ok: true } | { ok: false; message: string } | null>(null);
	const [io, setIo] = useState<{ load: Load; send: Send } | null>(null);
	useEffect(() => {
		void sealSupport().then(setSupport);
		const search = window.location?.search ?? "";
		if (process.env.NODE_ENV === "production" || !/[?&]packFixture=keys/.test(search)) return setIo({ load: liveLoad, send: sendMachineCommand });
		void import("@/components/pack/pack-keys-fixtures").then((m) => {
			const f = m.keysFixtureFromUrl(search);
			setIo(f ? m.fixtureKeysIo(f) : { load: liveLoad, send: sendMachineCommand });
		});
	}, []);
	const reload = useCallback(() => {
		if (io) void io.load().then(setState);
	}, [io]);
	useEffect(reload, [reload]);
	const ack = useCallback(
		(hostId: string, fingerprint: string) =>
			void fetch(`/api/pack/machines/${encodeURIComponent(hostId)}/key/ack`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fingerprint }) }).then(reload),
		[reload],
	);
	if (!io || !state || !support) return <p className="text-xs text-muted-foreground">Loading keys…</p>;
	if ("error" in state) return <p data-testid="keys-error" className="text-xs text-destructive">{state.error}</p>;
	if (state.machines.length === 0) return <p className="text-xs text-muted-foreground">No machines have reported yet.</p>;
	return <KeysView machines={state.machines} support={support} send={io.send} reload={reload} ack={ack} />;
}
