"use client";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
const COPY = {
    turn: {
        title: "Abort this turn?",
        line: "The partial answer stays in the transcript.",
        action: "Abort",
    },
    question: {
        title: "Dismiss this question?",
        line: "Skipped — the teacher moves on without it.",
        action: "Dismiss",
    },
    problem: {
        title: "Discard this problem?",
        line: "The problem is dropped — no solution is revealed.",
        action: "Discard",
    },
};
/** The dialog's pure body — exported for SSR pins (the delete-node
 * pattern). The wrapper owns effects + the portal. */
export function AbortTurnBody({ mode, onClose, onConfirm, busy = false, }) {
    const backdropDismiss = useBackdropDismiss(onClose);
    const copy = COPY[mode];
    return (<div role="dialog" aria-modal="true" aria-label={copy.title} data-testid="abort-turn-dialog" className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm" 
    // A genuine click on the scrim cancels — the cautious default, like Esc.
    {...backdropDismiss}>
			<div className="mx-4 w-full max-w-sm rounded-xl border bg-card p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
				<h2 className="text-sm font-semibold text-card-foreground" data-testid="abort-turn-title">
					{copy.title}
				</h2>
				<p className="mt-1.5 text-xs text-muted-foreground" data-testid="abort-turn-line">
					{copy.line}
					{busy && mode !== "turn" ? " The working turn stops too." : ""}
				</p>
				<div className="mt-4 flex justify-end gap-2">
					<button type="button" data-testid="abort-turn-cancel" onClick={onClose} className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
						Cancel
					</button>
					<button type="button" data-testid="abort-turn-confirm" onClick={onConfirm} 
    // Destructive red — the app's established destructive pair.
    className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20">
						{copy.action}
					</button>
				</div>
			</div>
		</div>);
}
export function AbortTurnDialog({ mode, onClose, onConfirm, busy = false, }) {
    // Esc cancels the popup (claimed — never a chained abort).
    useEffect(() => {
        if (mode === null)
            return;
        const onKeyDown = (e) => {
            if (e.key === "Escape") {
                // THE ONE-ESC LAW (keyboard round 2026-10-06): claim at the
                // document level — a window-level stopPropagation cannot stop
                // the earlier-registered global window listener.
                e.preventDefault();
                e.stopPropagation();
                onClose();
            }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [mode, onClose]);
    if (mode === null || typeof document === "undefined")
        return null;
    return createPortal(<AbortTurnBody mode={mode} onClose={onClose} onConfirm={() => onConfirm(mode)} busy={busy}/>, document.body);
}
//# sourceMappingURL=abort-turn-dialog.js.map