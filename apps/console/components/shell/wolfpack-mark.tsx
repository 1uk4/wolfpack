import { WOLF_HEAD_PATH } from "./wolf-head-path";

/**
 * WolfpackMark — the 1b wolf head (source: brand/wolf-head.svg, viewBox 64×64, evenodd), inlined as JSX so it
 * rides along with the components (no fetch, crisp at any size). Fills with currentColor so it follows the
 * theme; sizing/padding is the consumer's job. Keep the path in step with brand/wolf-head.svg — the
 * generated PWA/desktop icons are rendered from that file by scripts/gen-wolf-icons.mjs.
 *
 * Replaces the harness ring in the sidebar band (also the traffic-light gutter's resident in the merged desktop chrome).
 */
export function WolfpackMark({ className = "" }: { className?: string }) {
	return (
		<svg viewBox="0 0 64 64" className={className} fill="currentColor" fillRule="evenodd" aria-hidden="true">
			<path d={WOLF_HEAD_PATH} />
		</svg>
	);
}
