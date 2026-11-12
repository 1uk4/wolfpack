"use client";

/**
 * THE PACK (work-wolfpack-bq9iYp3): one pop-over over chat that replaces the Settings dialog. A left menu (Machines, Devices, Wolves,
 * Domains, Keys, with "This device" small at the bottom), problems as badges on menu items only, and the open section's body on the right.
 * Open state lives in the pack-health store (openPackHealth / closePackHealth); sections and badges in src/core/pack/pack-sections.ts;
 * bodies in pack-section-bodies.tsx. Under md the menu is a strip across the top and the body fills the screen.
 *   url: ?pack=<section> opens the Pack on that section at page load (PackHealthHost reads it); an unknown name opens Machines.
 */
import { useEffect, useRef, useState } from "react";
import { SettingsIcon } from "lucide-react";
import { OverlayHeader, OverlayShell } from "@/components/shell/overlay-shell";
import { usePackHealth } from "@/components/pack/pack-health";
import { PACK_SECTION_BODIES } from "@/components/pack/pack-section-bodies";
import { closePackHealth, openPackHealth, requestedPackSection } from "@/components/pack/pack-health-store";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { cn } from "@/lib/utils";
import { PACK_SECTIONS, packEntrySummary, sectionBadges, type PackBadge, type PackSectionId, type Tone } from "@/src/core";

const DOT: Record<Tone, string> = { red: "bg-red-500", amber: "bg-amber-500", grey: "bg-muted-foreground/50", green: "bg-emerald-500" };
const TEXT: Record<Tone, string> = { red: "text-red-600 dark:text-red-400", amber: "text-amber-600 dark:text-amber-400", grey: "text-muted-foreground", green: "text-emerald-600 dark:text-emerald-400" };

function Badge({ badge, id }: { badge: PackBadge; id: string }) {
	return (
		<span data-testid={`pack-badge-${id}`} aria-label={`${badge.count} need attention`} className={cn("ml-auto min-w-4 rounded-full px-1 text-center text-[10px] leading-4 text-white", DOT[badge.tone])}>
			{badge.count}
		</span>
	);
}

/** The sidebar's Settings entry: opens the Pack, and says how the pack is ("All good", "2 need attention", "sfo-01 offline"). */
export function PackSettingsEntry({ onOpen }: { onOpen?: () => void }) {
	const h = usePackHealth();
	const sum = packEntrySummary({ snapshot: h.snapshot, reachable: h.reachable, lastSeenAt: h.lastSeenAt, now: h.now });
	return (
		<button
			type="button"
			data-testid="settings-entry"
			data-tone={sum.tone}
			aria-haspopup="dialog"
			aria-label={`Settings: ${sum.label}`}
			onClick={(e) => {
				openPackHealth(e.currentTarget);
				onOpen?.();
			}}
			className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground max-md:py-2.5"
		>
			<SettingsIcon className="size-3 shrink-0" />
			<span className="uppercase tracking-wider">Settings</span>
			<span aria-hidden className={cn("ml-auto size-2 shrink-0 rounded-full", DOT[sum.tone])} />
			<span className={cn("max-w-[55%] truncate", sum.tone !== "green" && TEXT[sum.tone])}>{sum.label}</span>
		</button>
	);
}

/**
 * Old settings: open the Settings dialog only after the Pack has unmounted (next frame). Opened in the same tick, the Pack's
 * unmount dropped focus to BODY after the dialog had taken it. Then focus the dialog's first control, and when the dialog goes
 * away (Esc, close) put focus back on the sidebar Settings entry.
 */
function openSettingsAfterPack(open: () => void): void {
	requestAnimationFrame(() => {
		open();
		requestAnimationFrame(() => {
			const backdrop = document.querySelector<HTMLElement>('[data-testid="settings-backdrop"]');
			if (!backdrop) return;
			if (!backdrop.contains(document.activeElement)) backdrop.querySelector<HTMLElement>('[role="dialog"] button, [role="dialog"] a[href], [role="dialog"] input, [role="dialog"] select, [role="dialog"] textarea')?.focus();
			const watch = new MutationObserver(() => {
				if (backdrop.isConnected) return;
				watch.disconnect();
				Array.from(document.querySelectorAll<HTMLElement>('[data-testid="settings-entry"]')).find((el) => el.getClientRects().length > 0)?.focus();
			});
			watch.observe(document.body, { childList: true, subtree: true });
		});
	});
}

export function PackPanel() {
	const [section, setSection] = useState<PackSectionId>(requestedPackSection);
	const h = usePackHealth();
	const settings = useSettingsDialog();
	const badges = sectionBadges({ snapshot: h.snapshot, reachable: h.reachable, now: h.now });
	// Sections that fetch their own badge data: PACK_SECTIONS is a constant list, so the hooks run in a fixed order.
	for (const s of PACK_SECTIONS) {
		const own = s.useBadge?.();
		if (own !== undefined) badges[s.id] = own;
	}
	const sum = packEntrySummary({ snapshot: h.snapshot, reachable: h.reachable, lastSeenAt: h.lastSeenAt, now: h.now });
	const item = (id: PackSectionId, label: string, small = false) => {
		const b = badges[id];
		return (
			<button
				key={id}
				type="button"
				data-testid={`pack-menu-${id}`}
				aria-current={section === id ? "page" : undefined}
				onClick={() => setSection(id)}
				className={cn("flex items-center gap-2 rounded-sm px-3 py-1.5 text-left text-xs max-md:min-h-11 max-md:shrink-0 max-md:whitespace-nowrap max-md:py-2", small && "text-muted-foreground", section === id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent")}
			>
				{label}
				{b && <Badge badge={b} id={id} />}
			</button>
		);
	};
	// Keep the open tab visible in the phone's scrolling strip, on mount (?pack=<section>) and when it changes.
	const tabs = useRef<HTMLDivElement>(null);
	useEffect(() => {
		tabs.current?.querySelector<HTMLElement>(`[data-testid="pack-menu-${section}"]`)?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
	}, [section]);
	const Body = PACK_SECTION_BODIES[section];
	const main = PACK_SECTIONS.filter((s) => s.id !== "this-device");
	const thisDevice = PACK_SECTIONS.find((s) => s.id === "this-device")!;
	return (
		<OverlayShell
			labelledBy="pack-title"
			testId="pack-health-modal"
			closeTestId="pack-health-close"
			onClose={closePackHealth}
			header={(close) => (
				<OverlayHeader className="flex items-center gap-2 pb-3 pl-4">
					<h2 id="pack-title" className="text-sm font-semibold">Pack</h2>
					<span className={cn("flex min-w-0 items-center gap-1.5 truncate text-xs", TEXT[sum.tone])}>
						<span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[sum.tone])} />
						{sum.label}
					</span>
					{close}
				</OverlayHeader>
			)}
		>
			<div className="mx-auto flex w-full max-w-5xl min-h-0 flex-1 gap-4 text-xs max-md:flex-col max-md:gap-2">
				<div ref={tabs} className="flex w-44 shrink-0 flex-col gap-0.5 max-md:w-full max-md:flex-row max-md:items-stretch max-md:overflow-x-auto max-md:border-b max-md:pb-1 max-md:[scrollbar-width:none]" data-testid="pack-tabs">
					<nav aria-label="Pack sections" className="flex flex-col gap-0.5 max-md:flex-row">
						{main.map((s) => item(s.id, s.label))}
						{item(thisDevice.id, thisDevice.label, true)}
					</nav>
					<div className="mt-auto flex flex-col gap-1 pt-3 max-md:mt-0 max-md:flex-row max-md:pt-0">
						<button
							type="button"
							data-testid="pack-open-old-settings"
							onClick={() => {
								closePackHealth();
								openSettingsAfterPack(settings.open);
							}}
							className="rounded-sm px-3 py-1.5 text-left text-[11px] text-muted-foreground/70 underline-offset-2 hover:underline max-md:flex max-md:min-h-11 max-md:shrink-0 max-md:items-center max-md:whitespace-nowrap max-md:py-2"
						>
							Old settings
						</button>
					</div>
				</div>
				<div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto pb-6">
					<Body />
				</div>
			</div>
		</OverlayShell>
	);
}
