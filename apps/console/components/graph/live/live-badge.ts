/**
 * THE AVATAR BADGE (pure): a wolf or feature thread is a filled disc in the wolf's colour with a white wolf glyph, constant screen size,
 * and ONE state ring hugging it (resting none, working a rotating arc, needs-you a full amber pulsing ring, offline dimmed with none).
 * Sub-agent dots sit on that ring's radius. A wolf parks beside its target, never on it. Work-wolfpack-1Djd6IR.
 */
import type { LiveTuning } from "./live-tuning";

export interface Pt { x: number; y: number }

export interface RingStyle {
	kind: "none" | "arc" | "full";
	/** Amber (needs you) instead of the wolf's colour. */
	amber: boolean;
	/** Arc length in radians (full ring: 2 pi). */
	sweepRad: number;
	/** The soft pulse (needs-you only). */
	pulse: boolean;
	/** The badge is desaturated and dimmed (offline). */
	dim: boolean;
}

const NONE: RingStyle = { kind: "none", amber: false, sweepRad: 0, pulse: false, dim: false };

/** The state ring for a wolf or feature thread. Offline wins over everything: dimmed, no ring. */
export function badgeRing(s: { online: boolean; working: boolean; needsYou: boolean }, t: LiveTuning): RingStyle {
	if (!s.online) return { ...NONE, dim: true };
	if (s.needsYou) return { kind: "full", amber: true, sweepRad: Math.PI * 2, pulse: true, dim: false };
	if (s.working) return { kind: "arc", amber: false, sweepRad: (t.arcDeg * Math.PI) / 180, pulse: false, dim: false };
	return NONE;
}

/** Badge radius, screen px. */
export function badgeRadiusPx(mobile: boolean, t: LiveTuning): number {
	return (mobile ? t.badgePhonePx : t.badgePx) / 2;
}

/** Radius (screen px) of the state ring's centre line, which the sub-agent dots sit on. */
export function stateRingRadiusPx(mobile: boolean, t: LiveTuning): number {
	return badgeRadiusPx(mobile, t) + t.ringGapPx + t.ringStrokePx / 2;
}

/**
 * Where a wolf settles at `target` (world): `badgeR + nodeR + gap` screen px away, on the side facing `from` (where it came from), so it
 * never covers the node. Arriving from the node itself falls back to straight up. `k` = screen px per world unit; radii are screen px.
 */
export function parkingSpot(target: Pt, from: Pt, nodeRPx: number, badgeRPx: number, gapPx: number, k: number): Pt {
	const d = (nodeRPx + badgeRPx + gapPx) / k;
	let dx = from.x - target.x;
	let dy = from.y - target.y;
	const len = Math.hypot(dx, dy);
	if (len < 1e-9) [dx, dy] = [0, -1];
	else [dx, dy] = [dx / len, dy / len];
	return { x: target.x + dx * d, y: target.y + dy * d };
}

/** Palette for a wolf the console roster has no colour for: stable per name. */
const FALLBACK = ["#e5734f", "#3fa7a0", "#b277d6", "#d4a02c", "#5b8def", "#d9608c", "#6aa84f", "#8a7ae0"];
export function wolfFallbackHex(name: string): string {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
	return FALLBACK[h % FALLBACK.length]!;
}

/** Whether a `#rrggbb` colour is light (decides the pill's surface so both themes stay legible). */
export function isLightHex(hex: string): boolean {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex);
	if (!m) return false;
	const n = parseInt(m[1]!, 16);
	return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.55;
}

