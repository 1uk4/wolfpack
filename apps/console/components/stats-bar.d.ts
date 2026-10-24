import { type ReactNode } from "react";
import { type TurnUsage } from "@/src/core";
/**
 * The below-composer stats bar (wave 4 observability): the session's
 * money/context footprint as one quiet row beneath the composer —
 * LEFT-aligned: context window + session cost; RIGHT-aligned: model +
 * thinking level. Clicking the left side opens the per-turn detail popover.
 *
 *  Pre-chat views (home, /chat/new) render NO left side at all (owner,
 *  wave 7 sweep: the knowledge-context budget slider that used to live
 *  there died with the injection; a "— · —" summary over an empty
 *  popover is pure noise) — the dictation strip's middle simply widens.
 *
 * All folds come from core/prices.ts (sessionCost, contextWindow, turnCost)
 * — no cost math lives here. Absent data renders "—", never zero (the
 * doctrine): no turns yet → every figure is "—"; turns the price table
 * can't price count as unpriced, shown in the popover, never folded into
 * a fake $0. The RIGHT side is the model + thinking control (components/
 * model-picker.tsx): one controller for the conversation agents, backed by
 * pi-ai's catalog; the buttons show the EFFECTIVE model (the record's
 * settings, else config's pin), while the left-side figures still fold the
 * turn log's actual billed models.
 */
export declare function StatsBar({ turns, dictationSlot, chatId, leadingSlot, }: {
    turns: TurnUsage[];
    /** The bound session (per-session models, owner 2026-09-28): present
     *  on the in-session bar — the model control binds THE SESSION'S own
     *  record; absent on the draft surfaces, where it binds the strong
     *  slot (the new-session default). */
    chatId?: string;
    /** The dictation strip (STT wave, 2026-09-17): the row's middle is dead
     *  space between the session data and the model control — the mic
     *  button lives there, and while recording the meter unfurls to fill
     *  whatever width the row has (owner placement). */
    dictationSlot?: ReactNode;
    /** The row's LEFT edge (practice sessions, 2026-10-04): the home
     *  composer's teach | practice switch rides here — before the session
     *  data (which renders nothing pre-chat on that surface). */
    leadingSlot?: ReactNode;
}): any;
//# sourceMappingURL=stats-bar.d.ts.map