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
			<path d="M8 2L24 18H40L56 2L57 27L63 33L52 39L32 62L12 39L1 33L7 27Z M16 28L27 32L19.5 35.5Z M48 28L37 32L44.5 35.5Z" />
		</svg>
	);
}
