/**
 * Effect drawers for the live overlay: a small registry (pulse, trail, ring, glow) so richer effects can be added later by adding an
 * entry. Every drawer gets the same args, draws in WORLD units under the camera (screen px are divided by `k`) and scales itself by
 * `intensity` (1-5). Reduced motion: static, no growth, no breathing.
 */
export interface EffectArgs {
	ctx: CanvasRenderingContext2D;
	x: number;
	y: number;
	/** Base radius, world units. */
	r: number;
	/** Camera zoom (world -> screen). */
	k: number;
	/** Progress 0..1 (0 = just started). */
	t: number;
	/** `#rrggbb`. */
	color: string;
	intensity: number;
	reduced: boolean;
	/** Extra opacity multiplier 0..1. */
	alpha?: number;
	/** Trail end point (world). */
	toX?: number;
	toY?: number;
	/** performance.now(), for breathing. */
	time?: number;
}
export type EffectDrawer = (a: EffectArgs) => void;

export const AMBER = "#f59e0b";

export function rgba(hex: string, a: number): string {
	const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
	if (!m) return `rgba(128,128,128,${a})`;
	return `rgba(${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)},${Math.max(0, Math.min(1, a))})`;
}

const clampI = (i: number) => Math.min(5, Math.max(1, Number.isFinite(i) ? i : 1));
/** Size multiplier: 1 at intensity 1, 1.8 at 5. */
export const sizeMul = (i: number) => 0.8 + 0.2 * clampI(i);
/** Opacity multiplier: about .5 at intensity 1, 1 at 5. */
export const alphaMul = (i: number) => 0.35 + 0.13 * clampI(i);

const pulse: EffectDrawer = ({ ctx, x, y, r, k, t, color, intensity, reduced, alpha = 1 }) => {
	const a = alphaMul(intensity) * alpha;
	const rr = reduced ? r * 1.8 * sizeMul(intensity) : r * (1 + t * 2.4 * sizeMul(intensity));
	const fade = reduced ? 0.7 : 1 - t;
	ctx.beginPath();
	ctx.arc(x, y, rr, 0, Math.PI * 2);
	ctx.fillStyle = rgba(color, 0.08 * a * fade);
	ctx.fill();
	ctx.lineWidth = 1.2 / k;
	ctx.strokeStyle = rgba(color, 0.6 * a * fade);
	ctx.stroke();
};

const trail: EffectDrawer = ({ ctx, x, y, toX, toY, k, t, color, intensity, alpha = 1 }) => {
	if (toX === undefined || toY === undefined) return;
	const a = (1 - t) * 0.55 * alphaMul(intensity) * alpha;
	if (a <= 0.01) return;
	ctx.beginPath();
	ctx.moveTo(x, y);
	ctx.lineTo(toX, toY);
	ctx.lineWidth = (0.9 + 0.1 * sizeMul(intensity)) / k;
	ctx.strokeStyle = rgba(color, a);
	ctx.stroke();
};

const ring: EffectDrawer = ({ ctx, x, y, r, k, color, intensity, reduced, time = 0, alpha = 1 }) => {
	const breath = reduced ? 0.85 : 0.65 + 0.3 * Math.sin(time / 420);
	ctx.beginPath();
	ctx.arc(x, y, r + (3.5 + (reduced ? 0 : 1.2 * Math.sin(time / 420))) / k, 0, Math.PI * 2);
	ctx.lineWidth = 1.6 / k;
	ctx.strokeStyle = rgba(color, breath * Math.min(1, alphaMul(intensity) + 0.3) * alpha);
	ctx.stroke();
};

const glow: EffectDrawer = ({ ctx, x, y, r, color, intensity, alpha = 1 }) => {
	const outer = r * (2.2 + 0.4 * sizeMul(intensity));
	const g = ctx.createRadialGradient(x, y, r * 0.4, x, y, outer);
	g.addColorStop(0, rgba(color, 0.28 * alphaMul(intensity) * alpha));
	g.addColorStop(1, rgba(color, 0));
	ctx.fillStyle = g;
	ctx.beginPath();
	ctx.arc(x, y, outer, 0, Math.PI * 2);
	ctx.fill();
};

export const EFFECTS: Record<string, EffectDrawer> = { pulse, trail, ring, glow };
