/** Viewer column width on desktop: one global persisted value, clamped to [320px, 70% of the window]. */
export const VIEWER_WIDTH_KEY = "wolfpack:viewer:width";
export const DEFAULT_VIEWER_WIDTH = 480;
export const MIN_VIEWER_WIDTH = 320;

type ReadStore = Pick<Storage, "getItem">;
type WriteStore = Pick<Storage, "setItem">;

export function clampViewerWidth(px: number, innerWidth: number): number {
	const max = Math.max(MIN_VIEWER_WIDTH, Math.floor((innerWidth * 7) / 10));
	return Math.min(max, Math.max(MIN_VIEWER_WIDTH, Math.round(px)));
}

export function readViewerWidth(store: ReadStore | null | undefined): number {
	try {
		const n = Number(store?.getItem(VIEWER_WIDTH_KEY));
		return Number.isFinite(n) && n > 0 ? n : DEFAULT_VIEWER_WIDTH;
	} catch {
		return DEFAULT_VIEWER_WIDTH;
	}
}

export function writeViewerWidth(store: WriteStore | null | undefined, px: number): void {
	try {
		store?.setItem(VIEWER_WIDTH_KEY, String(Math.round(px)));
	} catch {
		/* storage unavailable: the width just isn't remembered */
	}
}
