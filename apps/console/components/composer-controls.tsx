"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { MenuShell } from "@/components/menu-shell";
import { Toggle } from "@/components/settings/controls";
import { changeSettings, DEFAULT_SETTINGS, fetchSettings, putSettings, TIERS, type SettingsPatch, type Tier, type ThreadSettingsState } from "@/components/composer-settings";
import { settingsUrl } from "@/components/thread-transport";

/** The thread's settings from the wolf, with an optimistic `change` that rolls back (and reports) when the wolf refuses. */
export function useThreadSettings(wolf: string, slug: string) {
	const [settings, setSettings] = useState<ThreadSettingsState>(DEFAULT_SETTINGS);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ref = useRef(settings);
	ref.current = settings;
	const url = settingsUrl(wolf, slug);

	useEffect(() => {
		let alive = true;
		fetchSettings(url)
			.then((s) => {
				if (!alive) return;
				setSettings(s);
				setLoaded(true);
			})
			.catch(() => {
				/* no controls without a readable setting: the composer works without them */
			});
		return () => {
			alive = false;
		};
	}, [url]);

	const change = useCallback(
		async (patch: SettingsPatch) => {
			setError(null);
			const r = await changeSettings({
				current: ref.current,
				patch,
				put: (p) => putSettings(url, p),
				set: (update) => setSettings((s) => update(s)),
			});
			if (!r.ok) setError(r.error);
		},
		[url],
	);
	return { settings, loaded, error, change };
}

/**
 * The composer's per-thread controls, next to the send button: a model-tier dropdown (the wolf's main / smart / fast, the
 * resolved model as a hint) and the auto-ship toggle (task_done ships without a card in this thread).
 */
export function ComposerControls({
	settings,
	error,
	onChange,
}: {
	settings: ThreadSettingsState;
	error?: string | null;
	onChange: (patch: SettingsPatch) => void;
}) {
	const [open, setOpen] = useState(false);
	const anchor = useRef<HTMLDivElement>(null);
	const model = settings.models?.[settings.tier];

	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			const t = e.target as Element;
			if (t instanceof Element && t.closest("[data-lh-menu]")) return;
			if (anchor.current && !anchor.current.contains(t)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	return (
		<div data-testid="composer-controls" className="flex shrink-0 items-center gap-2 self-center text-xs">
			{error && (
				<span role="alert" data-testid="composer-controls-error" className="max-w-48 truncate text-destructive" title={error}>
					{error}
				</span>
			)}
			<div ref={anchor} className="relative">
				<button
					type="button"
					data-testid="tier-trigger"
					aria-haspopup="menu"
					aria-expanded={open}
					aria-label={`Model tier: ${settings.tier}`}
					title={model ? `${settings.tier} → ${model}` : settings.tier}
					onClick={() => setOpen((o) => !o)}
					className="flex items-center gap-1 rounded-full border bg-card/85 px-2.5 py-1 transition-colors hover:border-border hover:bg-muted"
				>
					<span className="text-card-foreground">{settings.tier}</span>
					<span aria-hidden className="text-muted-foreground">▾</span>
				</button>
				{open && (
					<MenuShell anchorRef={anchor} testid="tier-menu" preferredSide="up" menuClass="flex w-64 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl">
						<TierMenuList
							settings={settings}
							onPick={(tier) => {
								setOpen(false);
								if (tier !== settings.tier) onChange({ tier });
							}}
						/>
					</MenuShell>
				)}
			</div>
			<label className="flex items-center gap-1.5 text-muted-foreground" title="task_done ships without asking in this thread">
				<span>Auto-ship</span>
				<Toggle checked={settings.autoShip} onChange={(next) => onChange({ autoShip: next })} label="Auto-ship" />
			</label>
		</div>
	);
}

/** The tier menu body: the wolf's three tiers, the resolved model beside each, a ✓-style highlight on the current one. */
export function TierMenuList({ settings, onPick }: { settings: ThreadSettingsState; onPick: (tier: Tier) => void }) {
	return (
		<>
			{TIERS.map((tier) => (
				<button
					key={tier}
					type="button"
					role="menuitemradio"
					aria-checked={tier === settings.tier}
					data-testid={`tier-option-${tier}`}
					onClick={() => onPick(tier)}
					className={cn("flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted", tier === settings.tier && "bg-muted/60")}
				>
					<span className="text-card-foreground">{tier}</span>
					<span className="min-w-0 truncate text-muted-foreground">{settings.models?.[tier] ?? ""}</span>
				</button>
			))}
			<div className="mt-1 border-t px-2 pt-1.5 text-muted-foreground">This thread's model. A change applies from the next turn.</div>
		</>
	);
}
