/** The Settings modal's routed tabs: /prompts is the Prompts tab, /settings is Wolf settings. Other tabs have no URL. */
export type RoutedSection = "prompts" | "wolf";

const PATHS: Record<RoutedSection, string> = { prompts: "/prompts", wolf: "/settings" };

/** The tab a URL asks for, with its query string kept as-is (the Prompts graph and node params live in it). null: not a settings URL. */
export function parseSettingsRoute(pathname: string, search: string): { section: RoutedSection; search: string } | null {
	const section = (Object.keys(PATHS) as RoutedSection[]).find((s) => PATHS[s] === pathname);
	if (!section) return null;
	const q = search.replace(/^\?/, "");
	return { section, search: q ? `?${q}` : "" };
}

/** The path a tab navigates to, or null for tabs that have no URL. */
export function settingsTabHref(section: string): string | null {
	return section === "prompts" || section === "wolf" ? PATHS[section] : null;
}
