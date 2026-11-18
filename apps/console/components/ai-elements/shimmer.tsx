"use client";

import { memo, type CSSProperties } from "react";
import { cn } from "@/lib/utils";

// Text with a highlight sweeping across it; the sweep is a CSS animation
// (`wp-shimmer` in globals.css).
export const Shimmer = memo(function Shimmer({
	children,
	className,
	duration = 2,
}: {
	children: string;
	className?: string;
	duration?: number;
}) {
	return (
		<span
			className={cn("wp-shimmer relative inline-block bg-clip-text text-transparent", className)}
			style={{ "--shimmer-duration": `${duration}s`, "--spread": `${children.length * 2}px` } as CSSProperties}
		>
			{children}
		</span>
	);
});
