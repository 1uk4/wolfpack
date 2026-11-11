"use client";

import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { memo, type ComponentProps, type HTMLAttributes } from "react";
import remarkBreaks from "remark-breaks";
import {
	Block,
	Streamdown,
	defaultRehypePlugins,
	defaultRemarkPlugins,
	type MathPlugin,
	type PluginConfig,
} from "streamdown";
import { mdComponents, mdComponentsInline } from "@/components/shell/md-blocks";
import { cn } from "@/lib/utils";
import type { LhViewMessage } from "@/src/core";
import { escapeRawHtml, linkifyWorkIds, transformMathDelimiters } from "@/src/core";

export function Message({
	className,
	from,
	...props
}: HTMLAttributes<HTMLDivElement> & { from: LhViewMessage["role"] }) {
	return (
		<div
			className={cn(
				"group flex w-full max-w-[95%] flex-col gap-2",
				from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
				className,
			)}
			{...props}
		/>
	);
}

export function MessageContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			className={cn(
				"flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm",
				"group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3",
				"text-foreground",
				className,
			)}
			{...props}
		/>
	);
}

// streamdown plugins shared by every markdown surface. Dollar math ($..$ inline,
// $$ fenced for display) is native; transformMathDelimiters still reads the old
// \(..\) / \[..\] form. remark-breaks goes in the cjk plugin's remarkPluginsAfter
// slot because Streamdown's `remarkPlugins` prop would replace its defaults
// (GFM, code-fence metadata). Mermaid fences are rendered by the md-blocks `code`
// override (components/mermaid-render.ts). The cast covers a types-only skew:
// @streamdown/code ships shiki@3 types, streamdown expects shiki@4.
export const streamdownPlugins = {
	cjk: { ...cjk, remarkPluginsAfter: [...cjk.remarkPluginsAfter, remarkBreaks] },
	code,
	math: createMathPlugin({ singleDollarTextMath: true }),
} as unknown as PluginConfig;

export const MessageResponse = memo(
	({ className, children, ...props }: ComponentProps<typeof Streamdown>) => {
		const content =
			typeof children === "string" ? linkifyWorkIds(transformMathDelimiters(children)) : children;
		return (
			<Streamdown
				// wp-prose: Source Sans 3 and the emphasis colour tokens on every markdown surface.
				className={cn("wp-prose size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
				components={mdComponents}
				plugins={streamdownPlugins}
				{...props}
			>
				{content}
			</Streamdown>
		);
	},
	(prev, next) => prev.children === next.children && next.isAnimating === prev.isAnimating,
);
MessageResponse.displayName = "MessageResponse";

// Markdown for text that sits INSIDE a <button> (card options), where HTML allows
// only phrasing content. Block renders without Streamdown's <div>/<p> wrapper, and
// the inert component set turns block and interactive elements into <span>s.
const mathPlugin = (streamdownPlugins as { math: MathPlugin }).math;
const INLINE_REMARK = [...Object.values(defaultRemarkPlugins), mathPlugin.remarkPlugin, remarkBreaks];
const INLINE_REHYPE = [...Object.values(defaultRehypePlugins), mathPlugin.rehypePlugin];

export const InlineMarkdown = memo(({ children, className }: { children: string; className?: string }) => (
	<span className={cn("wp-prose", className)} data-testid="inline-md">
		<Block
			content={linkifyWorkIds(transformMathDelimiters(escapeRawHtml(children)))}
			index={0}
			isIncomplete={false}
			shouldParseIncompleteMarkdown={false}
			shouldNormalizeHtmlIndentation={false}
			components={mdComponentsInline}
			remarkPlugins={INLINE_REMARK}
			rehypePlugins={INLINE_REHYPE}
		/>
	</span>
));
InlineMarkdown.displayName = "InlineMarkdown";
