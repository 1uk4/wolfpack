/**
 * TAB CYCLES THE ACTIVE SURFACE'S TEXT FIELDS (owner, keyboard round
 * 2026-10-06): forward-only, wrapping; Tab from outside the chain
 * focuses the FIRST field — "navigate in". Shift+Tab is NOT ours (the
 * global thinking-level cycle owns it — owner ruling the same round),
 * so there is no reverse gear; the chain wraps.
 *
 * The event (not a prop bridge): the global Tab handler dispatches
 * `lh:kbd-cycle-fields` and each composer-bearing surface answers with
 * its own chain, gathered at event time from live DOM — the fields
 * mount/unmount with the docks, so a query beats stale refs. The quiz
 * dock's own Tab claim (rows ↔ thinking, while an option question is
 * expanded) stops propagation at the document level, so this hook only
 * ever hears Tab on surfaces WITHOUT an active claim — no double act.
 */
export declare function useFieldCycle(fields: () => readonly HTMLElement[]): void;
//# sourceMappingURL=field-cycle.d.ts.map