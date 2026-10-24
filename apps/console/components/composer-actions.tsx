"use client";

import type { ReactNode } from "react";

/** Home and the draft share one action row: the first-run setup pill,
 * centered when it is the sole action. */
export function ComposerActions({ setup }: { setup?: ReactNode }) {
	if (!setup) return null;
	return (
		<div
			data-testid="composer-actions"
			className="pointer-events-auto mb-2 flex flex-wrap items-center justify-center gap-2"
		>
			{setup}
		</div>
	);
}
