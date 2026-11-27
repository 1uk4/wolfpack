/**
 * The console's one z-scale. Every fixed or page-wide layer takes its z-index from here, so "what sits over what" is
 * decided in one place. Low to high:
 *
 *   content < viewer (panel, frames) < chat bar + icon < chat backdrop < chat sheet
 *           < menu (popovers, bar menus) < overlay (full-window panels) < modal (dialogs, palette) < popover (menus over modals, tooltips)
 *           < toast < fatal
 *
 * The chat bar is over every frame, the viewer and any open visualization, and under modals, which dim it.
 * Tailwind only sees whole class names, so `ZC` spells each one out; the test keeps `ZC` and `Z` in step.
 * Stacking inside one component (a resize handle, a sticky header) stays a local `z-10`.
 */
export const Z = {
	content: 0,
	viewer: 30,
	chatBar: 40,
	chatBackdrop: 41,
	chatSheet: 42,
	menu: 50,
	overlay: 60,
	modal: 70,
	popover: 80,
	toast: 90,
	fatal: 100,
} as const;

export const ZC = {
	viewer: "z-30",
	viewerPhone: "max-md:z-30",
	chatBar: "z-40",
	chatBackdrop: "z-41",
	chatSheet: "z-42",
	menu: "z-50",
	overlay: "z-60",
	overlayPhone: "max-md:z-60",
	modal: "z-70",
	popover: "z-80",
	toast: "z-90",
	fatal: "z-100",
} as const;
