/** Pure decision, exported for pins: does a focused BUTTON keep native
 *  Enter (true) or does Enter belong to submit (false)? */
export declare function buttonKeepsNativeEnter(el: HTMLElement): boolean;
/** Mount-scoped: while the dock is mounted (a problem/question is active),
 *  plain Enter anywhere outside a typing surface or button submits it. */
export declare function useEnterSubmits(submit: () => void): void;
//# sourceMappingURL=enter-submits.d.ts.map