import { type AppearanceSettings } from "@/src/core";
/** The resolved, fully-concrete appearance view (delta + factory merged). */
export declare function resolveAppearance(delta: AppearanceSettings | undefined): {
    mode: any;
    background: any;
    fontFamily: any;
    proseFontSize: any;
    sessionNameSerif: any;
    mdRendering: {
        headingWeight: any;
        boldColor: any;
        italicColor: any;
    };
};
/** The derived palette a chosen background implies (dark curve): background
 *  itself, the raised surfaces (card/popover/secondary/muted, +8), the
 *  accent (+22), the edges (border/input, +47), and primary-foreground
 *  (the inverted text on primary = the background's own color, as today). */
export declare function derivedPalette(background: string): Record<string, string>;
/** THE mapping: resolved appearance → the CSS variables to set on <html>.
 *  Absent entries = leave the factory stylesheet value in place. Pure —
 *  exported for tests. */
export declare function appearanceVars(a: ReturnType<typeof resolveAppearance>): Record<string, string>;
/** Pure: the previously-applied names ABSENT from the next var set —
 *  these get removeProperty so the factory stylesheet value returns.
 *  (Owner repro, fix wave: resets and toggle-backs never reverted because
 *  application only ever SET properties — the removal half was missing.)
 *  Exported for tests. */
export declare function staleVarNames(prevNames: readonly string[], nextVars: Record<string, string>): string[];
export declare function useAppearance(): any;
export declare function AppearanceProvider({ children }: {
    children: React.ReactNode;
}): any;
//# sourceMappingURL=appearance.d.ts.map