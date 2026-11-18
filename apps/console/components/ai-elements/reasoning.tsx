"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { ChevronDownIcon } from "lucide-react";
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { Streamdown } from "streamdown";
import { BrailleSpinner } from "@/components/shell/braille-spinner";
import { blurAfterPointerClick } from "@/components/shell/focus-hygiene";
import { mdComponents } from "@/components/shell/md-blocks";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { transformMathDelimiters } from "@/src/core";
import { streamdownPlugins } from "./message";
import { Shimmer } from "./shimmer";

const ReasoningContext = createContext<{ isStreaming: boolean; isOpen: boolean } | null>(null);

function useReasoning() {
	const context = useContext(ReasoningContext);
	if (!context) throw new Error("Reasoning components must be used within Reasoning");
	return context;
}

const AUTO_CLOSE_DELAY_MS = 1000;

// A collapsible "thinking" block. Collapsed by default; opening is always the
// reader's click. After a stream ends, a row that is open closes itself once,
// unless `autoClose` is false (a deliberate open must not be tidied away).
export const Reasoning = memo(function Reasoning({
	className,
	isStreaming = false,
	open,
	defaultOpen = false,
	autoClose = true,
	onOpenChange,
	children,
	...props
}: Omit<ComponentProps<typeof Collapsible>, "open" | "defaultOpen" | "onOpenChange"> & {
	isStreaming?: boolean;
	open?: boolean;
	defaultOpen?: boolean;
	autoClose?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	const [isOpen, setIsOpen] = useControllableState<boolean>({
		defaultProp: defaultOpen,
		onChange: onOpenChange,
		prop: open,
	});
	const everStreamed = useRef(isStreaming);
	const [hasAutoClosed, setHasAutoClosed] = useState(false);

	useEffect(() => {
		if (!autoClose || !everStreamed.current || isStreaming || !isOpen || hasAutoClosed) return;
		const timer = setTimeout(() => {
			setIsOpen(false);
			setHasAutoClosed(true);
		}, AUTO_CLOSE_DELAY_MS);
		return () => clearTimeout(timer);
	}, [autoClose, isStreaming, isOpen, setIsOpen, hasAutoClosed]);

	const value = useMemo(() => ({ isOpen, isStreaming }), [isOpen, isStreaming]);
	return (
		<ReasoningContext.Provider value={value}>
			<Collapsible className={cn("not-prose mb-4", className)} onOpenChange={setIsOpen} open={isOpen} {...props}>
				{children}
			</Collapsible>
		</ReasoningContext.Provider>
	);
});

// Streaming shows the spinner and a shimmering label; settled shows a static
// label that pairs with the user's own "Your thinking" rows.
export const ReasoningTrigger = memo(function ReasoningTrigger({
	className,
	children,
	...props
}: ComponentProps<typeof CollapsibleTrigger>) {
	const { isStreaming, isOpen } = useReasoning();
	return (
		<CollapsibleTrigger
			className={cn(
				"flex w-full items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground",
				className,
			)}
			{...props}
			// A pointer click must not leave focus here: the next Enter submits, it must not re-toggle.
			onClick={(e) => blurAfterPointerClick(e)}
		>
			{children ?? (
				<>
					{isStreaming && <BrailleSpinner label="Thinking" />}
					{isStreaming ? <Shimmer duration={1}>Thinking...</Shimmer> : <p>AGENT’S THINKING</p>}
					<ChevronDownIcon className={cn("size-4 transition-transform", isOpen ? "rotate-180" : "rotate-0")} />
				</>
			)}
		</CollapsibleTrigger>
	);
});

export const ReasoningContent = memo(function ReasoningContent({
	className,
	children,
	...props
}: Omit<ComponentProps<typeof CollapsibleContent>, "children"> & { children: string }) {
	return (
		<CollapsibleContent
			className={cn(
				"mt-4 text-sm text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:animate-in data-[state=open]:slide-in-from-top-2",
				className,
			)}
			{...props}
		>
			<Streamdown components={mdComponents} plugins={streamdownPlugins}>
				{transformMathDelimiters(children)}
			</Streamdown>
		</CollapsibleContent>
	);
});
