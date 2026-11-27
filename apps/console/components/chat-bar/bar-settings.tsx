"use client";

/**
 * The floating chat's settings gear (top-right icon group): a small toggle list for the attached thread. A compact popover above the bar
 * on desktop, a bottom sheet (rows of at least 44px) on the phone. Today it holds Auto-ship tasks, bound to the thread's own setting
 * on the wolf, so the switch here and the one beside the thread page's send button are the same value (see composer-settings.ts).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { SettingsIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { Toggle } from "@/components/settings/controls";
import { useThreadSettings } from "@/components/composer/composer-controls";
import { cn } from "@/lib/utils";
import { ZC } from "@/lib/z-layers";

export function BarSettings({ wolf, slug, phone, buttonClass }: { wolf: string; slug: string; phone: boolean; buttonClass: string }) {
	const [open, setOpen] = useState(false);
	const box = useRef<HTMLDivElement | null>(null);
	const gear = useRef<HTMLButtonElement | null>(null);
	// Every close (Esc, outside press, the sheet's backdrop) hands focus back to the gear.
	const close = useCallback(() => {
		setOpen(false);
		gear.current?.focus();
	}, []);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: Event) => {
			if (box.current && !box.current.contains(e.target as Node)) close();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			close();
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open, close]);

	return (
		<div ref={box} className="relative">
			<Hint label="Settings">
				<button ref={gear} type="button" data-testid="chat-bar-settings" aria-label="Settings" aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))} className={buttonClass}>
					<SettingsIcon aria-hidden className="size-4" />
				</button>
			</Hint>
			{open && <SettingsMenu wolf={wolf} slug={slug} phone={phone} onClose={close} />}
		</div>
	);
}

const FOCUSABLE = "button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex='-1'])";

/** Mounted only while open, so the thread's settings are fetched when the owner looks, not for every bar. */
function SettingsMenu({ wolf, slug, phone, onClose }: { wolf: string; slug: string; phone: boolean; onClose: () => void }) {
	const { settings, loaded, loadFailed, error, change } = useThreadSettings(wolf, slug);
	const dialog = useRef<HTMLDivElement | null>(null);
	const row = cn("flex w-full items-center gap-2 rounded-md px-2 py-1 text-sm", phone && "min-h-11");

	// Focus moves in on open (the dialog itself until the switch is enabled, then the first control).
	useEffect(() => {
		const d = dialog.current;
		if (!d) return;
		const inside = document.activeElement && d.contains(document.activeElement) && document.activeElement !== d;
		if (inside) return;
		(d.querySelector(FOCUSABLE) as HTMLElement | null ?? d).focus();
	}, [loaded, loadFailed]);

	// On the phone sheet, Tab stays inside it.
	const onKeyDown = (e: React.KeyboardEvent) => {
		if (!phone || e.key !== "Tab" || !dialog.current) return;
		const items = Array.from(dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE));
		if (items.length === 0) {
			e.preventDefault();
			return;
		}
		const first = items[0]!;
		const last = items[items.length - 1]!;
		const at = document.activeElement;
		if (e.shiftKey && (at === first || at === dialog.current)) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && at === last) {
			e.preventDefault();
			first.focus();
		}
	};

	return (
		<>
			{phone && <button type="button" tabIndex={-1} aria-label="Close settings" data-testid="bar-settings-backdrop" onClick={onClose} className={`fixed inset-0 ${ZC.chatSheet} bg-black/40 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200`} />}
			<div
				ref={dialog}
				role="dialog"
				tabIndex={-1}
				aria-label="Chat settings"
				data-testid="chat-bar-settings-menu"
				data-layout={phone ? "sheet" : "popover"}
				onKeyDown={onKeyDown}
				className={cn(
					`${ZC.menu} border bg-popover/95 p-1 outline-none backdrop-blur-xl motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150`,
					phone ? "fixed inset-x-0 bottom-0 rounded-t-2xl border-b-0 pb-[env(safe-area-inset-bottom)] shadow-2xl motion-safe:slide-in-from-bottom-4" : "absolute bottom-full right-0 mb-2 w-64 rounded-xl shadow-lg motion-safe:zoom-in-95",
				)}
			>
				{loadFailed && !loaded ? (
					<p data-testid="bar-settings-load-failed" className={cn(row, "text-muted-foreground")}>
						Couldn't load settings
					</p>
				) : (
					// The whole row is the hit target: a click on the words flips the switch.
					<label className={cn(row, "cursor-pointer hover:bg-muted/60")}>
						<span className="min-w-0 flex-1 truncate">Auto-ship tasks</span>
						<Toggle checked={settings.autoShip} disabled={!loaded} onChange={(next) => void change({ autoShip: next })} label="Auto-ship tasks" title="task_done ships without asking in this thread" />
					</label>
				)}
				{error && (
					<p role="alert" data-testid="bar-settings-error" className="px-2 py-1 text-xs text-destructive">
						{error}
					</p>
				)}
			</div>
		</>
	);
}
