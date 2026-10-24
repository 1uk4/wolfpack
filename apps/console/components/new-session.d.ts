import { type ReactNode } from "react";
/** The draft's pick set (owner round 10): the SAME shape the home pick
 *  bar lifts — resolved nodes as the learner SAW them at pick time. */
export type DraftPick = {
    id: string;
    name: string;
    statement: string;
};
/**
 * The draft's whole behavior as one pure seam: create the session (title =
 * the first message), persist the lifted pre-chat settings, return the push
 * target — /chat/<id>?prompt=<msg> — whose initialPrompt path delivers the
 * message as turn 1. Injected fetch/router so tests pin the contract.
 * Returns null on empty text; rethrows on transport failure (the caller's
 * busy flag resets).
 */
export declare function startDraftSession(text: string, fetchLike: typeof fetch, mode?: "practice", picks?: readonly DraftPick[]): Promise<string | null>;
/** The pure shell (no router) — the render-test seam: the draft view's
 *  visible surface, assembled from the same pieces a fresh chat shows. */
export declare function DraftShell({ busy, text, onChange, onSend, setupCta, mode, picks, onOpenPicker, onClearPicks, overlay, }: {
    busy: boolean;
    text: string;
    onChange: (v: string) => void;
    onSend: () => void;
    /** The practice draft (owner, 2026-10-04): ?mode=practice — the
     *  created session carries kind:"practice" and the copy changes
     *  (the practice agent opens; no probing). */
    mode?: "teach" | "practice";
    /** The first-run CTA (fix wave chunk B): the same "Set up your models"
     *  affordance home carries, rendered above the draft shell — passed by
     *  NewSession, which owns the configured state and the SetupDialog. */
    setupCta?: ReactNode;
    /** THE PICK BAR (owner round 10): the SAME pill the home screen
     *  carries above its composer — dashed "Pick nodes" when empty,
     *  count + Clear when picked. The draft screen has
     *  no graph behind it, so the picker opens the standalone chain-table
     *  overlay over fetched snapshot data (owned by NewSession). */
    picks?: DraftPick[];
    onOpenPicker?: () => void;
    onClearPicks?: () => void;
    /** THE PICKER SLOT (owner round 10b): the chain-table overlay hosts
     *  INSIDE the content column's relative container — the same law as
     *  the graph view (the overlay fills its column, never the sidebar).
     *  Passed as a node so the pick state stays in NewSession. */
    overlay?: ReactNode;
}): any;
export declare function NewSession({ initialConfigured, mode }: {
    initialConfigured: boolean;
    mode?: "teach" | "practice";
}): any;
//# sourceMappingURL=new-session.d.ts.map