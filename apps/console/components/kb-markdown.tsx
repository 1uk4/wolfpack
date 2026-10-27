"use client";

/**
 * Markdown for KB surfaces: the console's MessageResponse with links routed
 * through next/link (internal /kb paths) and unresolved wikilinks shown as
 * muted, non-clickable text.
 */
import Link from "next/link";
import type { AnchorHTMLAttributes } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { mdComponents } from "@/components/md-blocks";
import { UNRESOLVED_HREF } from "@/src/core";

function KbAnchor({ href, children, node: _node, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
	if (href === UNRESOLVED_HREF) {
		return (
			<span
				data-unresolved="true"
				title="No such entry"
				className="cursor-not-allowed text-muted-foreground underline decoration-dotted underline-offset-2"
			>
				{children}
			</span>
		);
	}
	if (href?.startsWith("/")) {
		return (
			<Link href={href} className="text-foreground underline underline-offset-2 hover:text-primary">
				{children}
			</Link>
		);
	}
	return (
		<a href={href} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2" {...rest}>
			{children}
		</a>
	);
}

const kbComponents = { ...mdComponents, a: KbAnchor };

export function KbMarkdown({ children }: { children: string }) {
	return (
		<MessageResponse mode="static" components={kbComponents}>
			{children}
		</MessageResponse>
	);
}
