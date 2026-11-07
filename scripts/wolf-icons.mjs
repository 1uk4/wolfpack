// Pure parts of the wolf-head icon generator (scripts/gen-wolf-icons.mjs): the one source SVG, the target list, and the SVG composer.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Path data of brand/wolf-head.svg (viewBox 0 0 64 64, evenodd): the single source of every generated icon. */
export const WOLF_PATH = /<path d="([^"]+)"/.exec(readFileSync(join(ROOT, "brand", "wolf-head.svg"), "utf8"))[1];

export const BG = "#0f141a"; // dark PWA background / theme colour
export const FG = "#e6edf3"; // mark colour

/** scale = the mark's width as a fraction of the canvas. radius = corner radius as a fraction of the canvas (0 = full-bleed square).
 *  Maskable: Android crops to a circle of 40% radius; the farthest vertex of the path from its centre must stay inside that circle, so 0.5 stays well inside. */
export const TARGETS = [
	{ out: "apps/console/public/icons/icon-192.png", size: 192, scale: 0.62, radius: 0 },
	{ out: "apps/console/public/icons/icon-512.png", size: 512, scale: 0.62, radius: 0 },
	{ out: "apps/console/public/icons/icon-maskable-512.png", size: 512, scale: 0.5, radius: 0 },
	{ out: "apps/console/public/icons/apple-touch-icon.png", size: 180, scale: 0.62, radius: 0 },
	{ out: "apps/console/app/icon.png", size: 64, scale: 0.8, radius: 0.2 },
];

/** A square canvas with the wolf head centred; bg null = transparent. */
export function markSvg({ size, scale, bg = BG, fg = FG, radius = 0 }) {
	const unit = (size * scale) / 64;
	const off = (size - 64 * unit) / 2;
	const rect = bg ? `<rect width="${size}" height="${size}" rx="${radius * size}" fill="${bg}"/>` : "";
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${rect}<path transform="translate(${off} ${off}) scale(${unit})" fill="${fg}" fill-rule="evenodd" d="${WOLF_PATH}"/></svg>`;
}
