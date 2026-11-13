"use client";
/**
 * The Devices section (settings > Devices): every browser/console paired with the hub. Each row: label, last used, a "this device" mark and a
 * Revoke button that asks first (an inline Confirm / Cancel, no modal on a modal). "Add device" mints a single-use pairing code (10 min) and
 * shows it with the hub's pairing link to open on the new device. Revoking THIS device signs the browser out (the next /api call is a 401).
 * Phone layout (<768px): rows stack, tap targets are 44px tall, nothing is wider than the viewport.
 *
 * DevicesView is the props-driven markup (SSR-testable); DevicesSection owns the fetches.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { canPair, canRevoke, devicesToShow } from "@/src/core";

export interface DeviceRow {
	id: string;
	label: string;
	kind: string;
	createdAt: string;
	lastUsedAt: string | null;
	self: boolean;
	addedBy?: string | null;
	addedById?: string | null;
}
export interface PairingCode {
	code: string;
	expiresAt: string;
	url?: string;
}

/** "just now" / "5 min ago" / "3 h ago" / "2 d ago" / "never" (lastUsedAt is about 5 s stale by design). */
export function lastUsedLabel(at: string | null, now: number): string {
	if (!at) return "never";
	const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)} min ago`;
	if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
	return `${Math.floor(s / 86400)} d ago`;
}

/** Devices that `id` added, directly or through the devices it added (what a cascade revoke would also take). */
export function addedDescendants(rows: readonly DeviceRow[], id: string): string[] {
	const out = new Set<string>();
	for (let grew = true; grew; ) {
		grew = false;
		for (const r of rows) if (r.addedById && (r.addedById === id || out.has(r.addedById)) && r.id !== id && !out.has(r.id)) (out.add(r.id), (grew = true));
	}
	return [...out];
}

const BTN = "min-h-11 rounded-sm border border-border px-3 font-ui text-sm transition-colors hover:bg-accent md:min-h-8";

export function DevicesView(p: {
	devices: DeviceRow[] | undefined;
	error?: string | null;
	now: number;
	confirming: string | null;
	busy?: boolean;
	code?: PairingCode | null;
	onAsk: (id: string | null) => void;
	onRevoke: (id: string, cascade: boolean) => void;
	/** Cascade checkbox state (reset whenever a different row is asked). */
	cascade?: boolean;
	onCascade?: (on: boolean) => void;
	onAdd: () => void;
	onDismissCode: () => void;
	/** No Revoke on any row. */
	readOnly?: boolean;
	/** Pairing allowed (default true). When false there is no Add device or code panel; `pairNote` says why. */
	canPair?: boolean;
	pairNote?: string;
	/** Shown instead of "No devices paired." when the list is empty. */
	emptyText?: string;
	/** Pack: drawn above the pairing code (a QR of the pairing link). Receives the link. */
	renderQr?: (url: string) => ReactNode;
}) {
	return (
		<div data-testid="devices-section" className="flex flex-col gap-3">
			{p.error && (
				<p role="alert" data-testid="devices-error" className="rounded-sm border border-red-500/40 px-3 py-2 text-xs text-red-500">
					{p.error}
				</p>
			)}
			{p.devices === undefined ? (
				<p className="text-xs text-muted-foreground/70">Loading devices…</p>
			) : p.devices.length === 0 ? (
				<p className="text-xs text-muted-foreground/70">{p.emptyText ?? "No devices paired."}</p>
			) : (
				<ul className="flex flex-col divide-y divide-border/60" data-testid="devices-list">
					{p.devices.map((d) => (
						<li key={d.id} data-testid={`device-${d.id}`} className="flex flex-col gap-2 py-3 md:flex-row md:items-center md:justify-between">
							<div className="min-w-0">
								<p className="truncate text-sm text-foreground">
									{d.label || d.id}
									{d.self && (
										<span data-testid="device-self" className="ml-2 rounded-sm bg-accent px-1.5 py-0.5 text-xs text-muted-foreground">
											this device
										</span>
									)}
								</p>
								<p className="text-xs text-muted-foreground">
									last used {lastUsedLabel(d.lastUsedAt, p.now)}
									{d.addedBy && <span data-testid="device-added-by"> · added by {d.addedBy}</span>}
								</p>
							</div>
							{p.readOnly ? null : p.confirming === d.id ? (
								<div className="flex flex-col gap-2 md:items-end" data-testid="device-confirm">
									{addedDescendants(p.devices!, d.id).length > 0 && (
										<label className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground md:min-h-0">
											<input type="checkbox" data-testid="device-cascade" checked={!!p.cascade} onChange={(e) => p.onCascade?.(e.target.checked)} />
											also revoke devices it added ({addedDescendants(p.devices!, d.id).length})
										</label>
									)}
									<div className="flex gap-2">
										<button type="button" disabled={p.busy} className={`${BTN} border-red-500/60 text-red-500`} onClick={() => p.onRevoke(d.id, !!p.cascade)}>
											{d.self ? "Sign out & revoke" : "Confirm revoke"}
										</button>
										<button type="button" className={BTN} onClick={() => p.onAsk(null)}>
											Cancel
										</button>
									</div>
								</div>
							) : (
								<button type="button" data-testid="device-revoke" className={BTN} onClick={() => p.onAsk(d.id)}>
									Revoke
								</button>
							)}
						</li>
					))}
				</ul>
			)}
			{p.canPair === false ? (
				p.pairNote && (
					<p data-testid="device-pair-note" className="text-xs text-muted-foreground">
						{p.pairNote}
					</p>
				)
			) : (
				<div>
					<button type="button" data-testid="device-add" disabled={p.busy} className={BTN} onClick={p.onAdd}>
						Add device
					</button>
				</div>
			)}
			{p.code && p.canPair !== false && (
				<div data-testid="device-code" className="flex flex-col gap-2 rounded-sm border border-border p-3">
					<p className="text-xs text-muted-foreground">On the new device, open the link or enter the code on the pairing page. Single use, expires {new Date(p.code.expiresAt).toLocaleTimeString()}.</p>
					{p.code.url && p.renderQr?.(p.code.url)}
					<p className="break-all font-mono text-lg tracking-wider text-foreground" data-testid="device-code-value">
						{p.code.code}
					</p>
					{p.code.url && (
						<a className="break-all text-xs underline" href={p.code.url} data-testid="device-code-link">
							{p.code.url}
						</a>
					)}
					<div>
						<button type="button" className={BTN} onClick={p.onDismissCode}>
							Done
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

/** The outcome of one Revoke press: the hub's refusal (if any) and the refreshed list. Pure over `fetchFn` so it is testable without a DOM. */
export async function revokeAndReload(fetchFn: typeof fetch, id: string, cascadeToo: boolean): Promise<{ error: string | null; devices?: DeviceRow[] }> {
	let error: string | null = null;
	const r = await fetchFn(`/api/devices/${encodeURIComponent(id)}${cascadeToo ? "?cascade=1" : ""}`, { method: "DELETE" });
	if (!r.ok) {
		const b = (await r.json().catch(() => ({}))) as { error?: string };
		error = b.error ?? `status ${r.status}`;
	}
	const l = await fetchFn("/api/devices");
	const body = (await l.json().catch(() => ({}))) as { devices?: DeviceRow[]; error?: string };
	if (!l.ok) return { error: body.error ?? `status ${l.status}` };
	return { error, devices: body.devices ?? [] }; // the refusal stays: a clean reload must not wipe it
}

export function DevicesSection({ singleMac, renderQr, pairNote, emptyText }: { singleMac?: boolean; renderQr?: (url: string) => ReactNode; pairNote?: string; emptyText?: string } = {}) {
	const [devices, setDevices] = useState<DeviceRow[] | undefined>();
	const [error, setError] = useState<string | null>(null);
	const [confirming, setConfirming] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [cascade, setCascade] = useState(false);
	const [code, setCode] = useState<PairingCode | null>(null);
	const [now, setNow] = useState(() => Date.now());

	const load = useCallback(async () => {
		try {
			const r = await fetch("/api/devices");
			const body = (await r.json().catch(() => ({}))) as { devices?: DeviceRow[]; error?: string };
			if (!r.ok) return setError(body.error ?? `status ${r.status}`);
			setError(null);
			setNow(Date.now());
			setDevices(body.devices ?? []);
		} catch {
			setError("could not reach the console");
		}
	}, []);
	useEffect(() => {
		void load();
	}, [load]);

	const revoke = async (id: string, cascadeToo: boolean) => {
		setBusy(true);
		try {
			// A self-revoke makes the NEXT /api call a hub 401, which the global fetch wrapper (hub-auth.tsx) turns into sign-out + /pair; the reload below is that call.
			const out = await revokeAndReload(fetch, id, cascadeToo);
			setConfirming(null);
			setError(out.error);
			if (out.devices) {
				setNow(Date.now());
				setDevices(out.devices);
			}
		} finally {
			setBusy(false);
		}
	};
	const add = async () => {
		setBusy(true);
		try {
			const r = await fetch("/api/devices/pairing-code", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
			const b = (await r.json().catch(() => ({}))) as Partial<PairingCode> & { error?: string };
			if (!r.ok || !b.code || !b.expiresAt) return setError(b.error ?? `status ${r.status}`);
			setError(null);
			setCode({ code: b.code, expiresAt: b.expiresAt, ...(b.url ? { url: b.url } : {}) });
		} finally {
			setBusy(false);
		}
	};
	return <DevicesView devices={devices && devicesToShow(devices, !!singleMac)} readOnly={!canRevoke(!!singleMac)} canPair={canPair(!!singleMac)} pairNote={pairNote} emptyText={emptyText} renderQr={renderQr} error={error} now={now} confirming={confirming} busy={busy} code={code} onAsk={(id) => { setCascade(false); setConfirming(id); }} cascade={cascade} onCascade={setCascade} onRevoke={(id, c) => void revoke(id, c)} onAdd={() => void add()} onDismissCode={() => { setCode(null); void load(); }} />;
}
