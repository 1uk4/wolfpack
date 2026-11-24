"use client";

/**
 * THE PACK PAGE (work-wolfpack-oz3wvq3): /pack/<section>, a full page that replaced the Pack modal and its side menu.
 * Header row: "Pack", the health dot and summary, the section tabs (one row, scrolls sideways on a phone), and a close button
 * that goes back to the page you came from (components/pack/pack-nav.ts). The section's body fills the page below.
 * Sections and badges: src/core/pack/pack-sections.ts; bodies: pack-section-bodies.tsx. Each section is a URL, so Back steps through them.
 * While the page is mounted it holds the health stream (holdPackHealth); layout: a flex column on md+ so the body is exactly the
 * viewport minus the header, which keeps PageViewer (/pack/wolves) bounded without any height constant.
 */
import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SettingsIcon, XIcon } from "lucide-react";
import { usePackHealth } from "@/components/pack/pack-health";
import { holdPackHealth } from "@/components/pack/pack-health-store";
import { PACK_SECTION_BODIES } from "@/components/pack/pack-section-bodies";
import { readPackReturn, rememberPackReturn, safeLocalPath } from "@/components/pack/pack-nav";
import { cn } from "@/lib/utils";
import { useSingleMac } from "@/components/shell/single-mac";
import { PACK_SECTIONS, packSectionsFor, packEntrySummary, sectionBadges, type PackBadge, type PackSectionId, type Tone } from "@/src/core";

export const DOT: Record<Tone, string> = { red: "bg-red-500", amber: "bg-amber-500", grey: "bg-muted-foreground/50", green: "bg-emerald-500" };
const TEXT: Record<Tone, string> = { red: "text-red-600 dark:text-red-400", amber: "text-amber-600 dark:text-amber-400", grey: "text-muted-foreground", green: "text-emerald-600 dark:text-emerald-400" };

function Badge({ badge, id }: { badge: PackBadge; id: string }) {
	return (
		<span data-testid={`pack-badge-${id}`} className={cn("min-w-4 rounded-full px-1 text-center text-[10px] leading-4 text-white", DOT[badge.tone])}>
			<span aria-hidden>{badge.count}</span>
			<span className="sr-only">{badge.count} need attention</span>
		</span>
	);
}

/** Esc leaves the page, unless the user is typing, a dialog/menu/listbox is open (its own Esc closes it), or a viewer panel is open. */
function typing(t: EventTarget | null): boolean {
	const el = t as HTMLElement | null;
	return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable === true);
}
function overlayOpen(): boolean {
	if (document.querySelector('[role="dialog"],[role="menu"],[role="listbox"]')) return true;
	return (document.activeElement as HTMLElement | null)?.getAttribute?.("aria-expanded") === "true";
}

export function PackPage({ section: requested }: { section: PackSectionId }) {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const from = searchParams?.get("from") ?? null;
	const singleMac = useSingleMac();
	const shown = packSectionsFor(singleMac);
	const hidden = !shown.some((s) => s.id === requested); // the desktop app has no Devices or This device
	const section: PackSectionId = hidden ? "machines" : requested;
	useEffect(() => holdPackHealth(), []);
	// The proxy's ?pack= redirect carries the page you came from in `from`: keep it as the close target, then drop it from the URL (replace).
	// Without it, a same-origin document.referrer is the fallback (a link that lands straight on /pack/...).
	useEffect(() => {
		if (from !== null) {
			const safe = safeLocalPath(from);
			if (safe) rememberPackReturn(safe);
			const p = new URLSearchParams(searchParams?.toString() ?? "");
			p.delete("from");
			const qs = p.toString();
			router.replace(qs ? `${pathname}?${qs}` : pathname);
			return;
		}
		try {
			if (document.referrer && new URL(document.referrer).origin === window.location.origin && !window.sessionStorage.getItem("wp.pack.return")) {
				const r = new URL(document.referrer);
				rememberPackReturn(r.pathname + r.search);
			}
		} catch {
			// no usable referrer
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on `from`; the other params are read at that moment
	}, [from, pathname, router]);
	useEffect(() => {
		if (hidden && pathname !== "/pack/machines" && pathname.startsWith("/pack/")) router.replace("/pack/machines");
	}, [hidden, pathname, router]);
	const close = () => router.push(readPackReturn());
	const closeRef = useRef(close);
	closeRef.current = close;
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented || typing(e.target) || overlayOpen()) return;
			if (document.querySelector('[data-testid="viewer-panel"]')) return;
			closeRef.current();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, []);

	const h = usePackHealth();
	const badges = sectionBadges({ snapshot: h.snapshot, reachable: h.reachable, now: h.now });
	// Sections that fetch their own badge data: PACK_SECTIONS is a constant list, so the hooks run in a fixed order.
	for (const s of PACK_SECTIONS) {
		const own = s.useBadge?.();
		if (own !== undefined) badges[s.id] = own;
	}
	const sum = packEntrySummary({ snapshot: h.snapshot, reachable: h.reachable, lastSeenAt: h.lastSeenAt, now: h.now });
	const tabs = useRef<HTMLElement>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const firstSection = useRef(true);
	// Moving between sections moves focus to the page heading (not on first load), so screen readers announce the new page.
	useEffect(() => {
		if (firstSection.current) return void (firstSection.current = false);
		heading.current?.focus?.();
	}, [section]);
	useEffect(() => {
		tabs.current?.querySelector<HTMLElement>(`[data-testid="pack-tab-${section}"]`)?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
	}, [section]);
	const Body = PACK_SECTION_BODIES[section];
	return (
		<div data-testid="pack-page" className="flex min-h-dvh flex-col text-xs md:h-dvh">
			<header className="wp-drag wp-lights-gutter flex shrink-0 items-center gap-3 border-b px-4 py-2 max-md:flex-wrap">
				<h1 ref={heading} tabIndex={-1} className="flex items-center gap-1.5 text-sm font-semibold"><SettingsIcon className="size-3.5" aria-hidden />Pack</h1>
				<span className={cn("flex min-w-0 items-center gap-1.5 truncate", TEXT[sum.tone])}>
					<span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[sum.tone])} />
					{sum.label}
				</span>
				<button type="button" data-testid="pack-close" aria-label="Close" title="Close (Esc)" onClick={close} className="order-2 ml-auto flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:order-3 max-md:size-11">
					<XIcon className="size-4" aria-hidden />
				</button>
				<nav ref={tabs} aria-label="Pack sections" data-testid="pack-tabs" className="order-3 flex min-w-0 gap-0.5 md:order-2 max-md:w-full max-md:overflow-x-auto max-md:[scrollbar-width:none]">
					{shown.map((s) => {
						const b = badges[s.id];
						const href = `/pack/${s.id}`;
						return (
							<a
								key={s.id}
								href={href}
								data-testid={`pack-tab-${s.id}`}
								aria-current={section === s.id ? "page" : undefined}
								onClick={(e) => {
									if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
									e.preventDefault();
									if (pathname !== href) router.push(href);
								}}
								className={cn("flex shrink-0 items-center gap-2 whitespace-nowrap rounded-sm px-3 py-1.5 max-md:min-h-11", section === s.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent")}
							>
								{s.label}
								{b && <Badge badge={b} id={s.id} />}
							</a>
						);
					})}
				</nav>
			</header>
			<main data-testid="pack-body" className="mx-auto flex w-full max-w-6xl min-w-0 flex-1 flex-col px-4 pt-4 md:min-h-0 md:overflow-y-auto">
				<Body />
			</main>
		</div>
	);
}
