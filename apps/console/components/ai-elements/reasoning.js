"use client";
import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "lucide-react";
import { BrailleSpinner } from "@/components/braille-spinner";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, } from "react";
import { Streamdown } from "streamdown";
import { transformMathDelimiters } from "@/src/core";
import { streamdownPlugins } from "./message";
import { mdComponents } from "@/components/md-blocks";
import { Shimmer } from "./shimmer";
const ReasoningContext = createContext(null);
export const useReasoning = () => {
    const context = useContext(ReasoningContext);
    if (!context) {
        throw new Error("Reasoning components must be used within Reasoning");
    }
    return context;
};
const AUTO_CLOSE_DELAY = 1000;
export const Reasoning = memo(({ className, isStreaming = false, open, defaultOpen, onOpenChange, children, ...props }) => {
    // COLLAPSED BY DEFAULT, ALWAYS (owner, streaming round 2026-10-01):
    // the old default opened on streaming and an auto-open effect
    // re-fought a manual collapse — the block "wasn't collapsible until
    // it finished". Collapsed is the default; opening is always the
    // learner's click; the auto-close after the stream still tidies a
    // row the learner had opened.
    const resolvedDefaultOpen = defaultOpen ?? false;
    const [isOpen, setIsOpen] = useControllableState({
        defaultProp: resolvedDefaultOpen,
        onChange: onOpenChange,
        prop: open,
    });
    const hasEverStreamedRef = useRef(isStreaming);
    const [hasAutoClosed, setHasAutoClosed] = useState(false);
    // Auto-close when streaming ends (once only, and only if it ever streamed)
    useEffect(() => {
        if (hasEverStreamedRef.current &&
            !isStreaming &&
            isOpen &&
            !hasAutoClosed) {
            const timer = setTimeout(() => {
                setIsOpen(false);
                setHasAutoClosed(true);
            }, AUTO_CLOSE_DELAY);
            return () => clearTimeout(timer);
        }
    }, [isStreaming, isOpen, setIsOpen, hasAutoClosed]);
    const handleOpenChange = useCallback((newOpen) => {
        setIsOpen(newOpen);
    }, [setIsOpen]);
    const contextValue = useMemo(() => ({ isOpen, isStreaming, setIsOpen }), [isOpen, isStreaming, setIsOpen]);
    return (<ReasoningContext.Provider value={contextValue}>
        <Collapsible className={cn("not-prose mb-4", className)} onOpenChange={handleOpenChange} open={isOpen} {...props}>
          {children}
        </Collapsible>
      </ReasoningContext.Provider>);
});
/* The settled label (owner round, 2026-10-05): static "Agent's thinking" —
   the duration was live-turn state that died on remount anyway ("thought
   for a few seconds"), bookkeeping for information we knowingly lose. The
   label pairs with the user's collapsed "Your thinking" rows — one
   language; motion (spinner + shimmer) stays the working signal. */
const defaultGetThinkingMessage = (isStreaming) => {
    if (isStreaming) {
        return <Shimmer duration={1}>Thinking...</Shimmer>;
    }
    return <p>AGENT’S THINKING</p>;
};
export const ReasoningTrigger = memo(({ className, children, getThinkingMessage = defaultGetThinkingMessage, ...props }) => {
    const { isStreaming, isOpen } = useReasoning();
    return (<CollapsibleTrigger className={cn(
        /* The heading register (owner round 4, 2026-10-05): the small
           mono caps of the card eyebrows — matching YOUR THINKING, whose
           rail offsets it by exactly the one-character difference. */
        "flex w-full items-center gap-2 text-muted-foreground text-xs font-medium uppercase tracking-wide transition-colors hover:text-foreground", className)} {...props} 
    /* FOCUS HYGIENE (owner, keyboard round 2026-10-10): a pointer click
       on the thinking toggle must not leave focus here — the learner's
       next Enter submits, it must not re-toggle. Radix composes this
       with its own toggle handler. */
    onClick={(e) => blurAfterPointerClick(e)}>
        {children ?? (<>
            {/* The working-state grammar (owner, streaming round
                2026-10-01): the Braille spinner replaces the brain icon
                WHILE STREAMING ONLY — motion is the signal, so a finished
                row carries no icon at all, just text + chevron. Size:
                the component default (h-3) — IDENTICAL to the placeholder
                spinner (owner, 2026-10-02): the handoff between the two
                states must be visually seamless, one size everywhere. */}
            {isStreaming && <BrailleSpinner label="Thinking"/>}
            {getThinkingMessage(isStreaming)}
            <ChevronDownIcon className={cn("size-4 transition-transform", isOpen ? "rotate-180" : "rotate-0")}/>
          </>)}
      </CollapsibleTrigger>);
});
// Shares message.tsx's Streamdown config (math delimiters, dark mermaid,
// remark-breaks) — reasoning renders the same contract as message text.
export const ReasoningContent = memo(({ className, children, ...props }) => (<CollapsibleContent className={cn("mt-4 text-sm", "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in", className)} {...props}>
      <Streamdown components={mdComponents} plugins={streamdownPlugins}>
        {transformMathDelimiters(children)}
      </Streamdown>
    </CollapsibleContent>));
Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
//# sourceMappingURL=reasoning.js.map