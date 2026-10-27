"use client";

/**
 * Markdown for KB surfaces: the console's MessageResponse with links routed
 * through next/link (internal paths), same-page anchors kept in-tab, headings
 * stamped with headingSlug ids (so #fragment links land), and unresolved
 * wikilinks shown as muted, non-clickable text.
 */
import Link from "next/link";
import { isValidElement, type AnchorHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { mdComponents } from "@/components/md-blocks";
import { UNRESOLVED_HREF, headingSlug } from "@/src/core";

function KbAnchor({ href, children, node: _node, target: _target, rel: _rel, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
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
	if (href?.startsWith("#")) {
		// same-page anchor: no new tab
		return (
			<a {...rest} href={href} className="underline underline-offset-2">
				{children}
			</a>
		);
	}
	if (href?.startsWith("/") && !href.startsWith("//")) {
		return (
			<Link href={href} className="text-foreground underline underline-offset-2 hover:text-primary">
				{children}
			</Link>
		);
	}
	if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
		// relative (./x.md) links resolve to nothing in the console: plain text
		return <span>{children}</span>;
	}
	// (streamdown already resolves "./x.md" to "/x.md" before this point, so those take the in-tab internal branch above)
	return (
		<a {...rest} href={href} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
			{children}
		</a>
	);
}

/** Plain text of a React subtree (heading content), for slugging. */
export function nodeText(node: ReactNode): string {
	if (node == null || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(nodeText).join("");
	if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
	return "";
}

// Heading ids use the same slug as [[x#Heading]] links (headingSlug); an empty
// slug (punctuation-only heading) gets no id. Components run after sanitize, so
// the ids are not stripped.
function heading(Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
	const Heading = ({ children, node: _node, ...rest }: HTMLAttributes<HTMLHeadingElement> & { node?: unknown }) => {
		const slug = headingSlug(nodeText(children));
		return (
			<Tag {...rest} id={slug || undefined}>
				{children}
			</Tag>
		);
	};
	Heading.displayName = Tag;
	return Heading;
}

const kbComponents = {
	...mdComponents,
	a: KbAnchor,
	h1: heading("h1"),
	h2: heading("h2"),
	h3: heading("h3"),
	h4: heading("h4"),
	h5: heading("h5"),
	h6: heading("h6"),
};

/** Opt-in document styling (lists with markers, small section titles, inline code); "compact" is the panel's text-xs size. */
const DOC_BASE =
	"[&_ul]:list-outside [&_ol]:list-outside [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_li]:my-0.5 [&_p]:my-2 [&_ul_ul]:my-0.5 [&_ol_ol]:my-0.5 " +
	"[&_h2]:mt-5 [&_h2]:mb-1.5 [&_h2]:font-semibold [&_h2]:tracking-normal [&_h2]:normal-case [&_h2]:text-foreground " +
	"[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:font-semibold [&_h4]:mt-2 [&_h4]:mb-1 [&_h4]:font-medium " +
	"[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:font-mono";
export const DOC_CLASS = {
	compact: `${DOC_BASE} text-xs [&_*]:text-xs [&_h2]:text-[0.8125rem]`,
	normal: `${DOC_BASE} text-sm [&_h2]:text-base [&_h3]:text-sm`,
} as const;

export function KbMarkdown({ children, density }: { children: string; density?: keyof typeof DOC_CLASS }) {
	return (
		<MessageResponse mode="static" components={kbComponents} className={density ? DOC_CLASS[density] : undefined}>
			{children}
		</MessageResponse>
	);
}
