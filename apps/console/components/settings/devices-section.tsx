"use client";
/**
 * The Devices section (settings > Devices): every browser/console paired with the hub. Each row: label, last used, a "this device" mark and a
 * Revoke button that asks first (an inline Confirm / Cancel, no modal on a modal). "Add device" mints a single-use pairing code (10 min) and
 * shows it with the hub's pairing link to open on the new device. Revoking THIS device signs the browser out (the next /api call is a 401).
 * Phone layout (<768px): rows stack, tap targets are 44px tall, nothing is wider than the viewport.
 *
 * DevicesView is the props-driven markup (SSR-testable); DevicesSection owns the fetches.
 */
import { useCallback, useEffect, useState } from "react";

export interface DeviceRow {
	id: string;
	label: string;
	kind: string;
	createdAt: string;
	lastUsedAt: string | null;
	self: boolean;
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

const BTN = "min-h-11 rounded-sm border border-border px-3 font-ui text-sm transition-colors hover:bg-accent md:min-h-8";

export function DevicesView(p: {
	devices: DeviceRow[] | undefined;
	error?: string | null;
	now: number;
	confirming: string | null;
	busy?: boolean;
	code?: PairingCode | null;
	onAsk: (id: string | null) => void;
	onRevoke: (id: string) => void;
	onAdd: () => void;
	onDismissCode: () => void;
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
				<p className="text-xs text-muted-foreground/70">No devices paired.</p>
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
								<p className="text-xs text-muted-foreground">last used {lastUsedLabel(d.lastUsedAt, p.now)}</p>
							</div>
							{p.confirming === d.id ? (
								<div className="flex gap-2" data-testid="device-confirm">
									<button type="button" disabled={p.busy} className={`${BTN} border-red-500/60 text-red-500`} onClick={() => p.onRevoke(d.id)}>
										{d.self ? "Sign out & revoke" : "Confirm revoke"}
									</button>
									<button type="button" className={BTN} onClick={() => p.onAsk(null)}>
										Cancel
									</button>
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
			<div>
				<button type="button" data-testid="device-add" disabled={p.busy} className={BTN} onClick={p.onAdd}>
					Add device
				</button>
			</div>
			{p.code && (
				<div data-testid="device-code" className="flex flex-col gap-2 rounded-sm border border-border p-3">
					<p className="text-xs text-muted-foreground">On the new device, open the link or enter the code on the pairing page. Single use, expires {new Date(p.code.expiresAt).toLocaleTimeString()}.</p>
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

export function DevicesSection() {
	const [devices, setDevices] = useState<DeviceRow[] | undefined>();
	const [error, setError] = useState<string | null>(null);
	const [confirming, setConfirming] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
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

	const revoke = async (id: string) => {
		setBusy(true);
		try {
			const r = await fetch(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
			if (!r.ok) {
				const b = (await r.json().catch(() => ({}))) as { error?: string };
				setError(b.error ?? `status ${r.status}`);
			}
			setConfirming(null);
			await load();
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
	return <DevicesView devices={devices} error={error} now={now} confirming={confirming} busy={busy} code={code} onAsk={setConfirming} onRevoke={(id) => void revoke(id)} onAdd={() => void add()} onDismissCode={() => { setCode(null); void load(); }} />;
}
