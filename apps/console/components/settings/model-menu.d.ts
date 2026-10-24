import type { ModelCatalogEntry } from "@/src/core";
/** The model dropdown body — fuzzy search + ranked list. `models ===
 *  undefined` is the catalog-loading state; an empty result list gets
 *  its own quiet line. */
export declare function ModelMenuList({ models, effectiveId, effectiveProvider, onPick, footer, }: {
    /** The full catalog — undefined while it loads. */
    models: ModelCatalogEntry[] | undefined;
    /** Currently effective id (the row gets the quiet highlight). */
    effectiveId: string | undefined;
    /** The effective id's provider (model-slots wave: the catalog
     *  federates multiple providers and ids can collide across them —
     *  the highlight must match BOTH coordinates or it lands on the
     *  wrong row). */
    effectiveProvider?: string;
    /** Receives the chosen entry. */
    onPick: (entry: ModelCatalogEntry) => void;
    /** Quiet footer note under the list (context-specific). */
    footer?: string;
}): any;
/** The thinking-level dropdown body — the levels this model actually
 *  supports, ✓ on the effective one. Same shape as the chat selector's. */
export declare function ThinkingMenuList({ levels, effectiveLevel, onPick, empty, footer, }: {
    levels: string[];
    effectiveLevel: string | undefined;
    onPick: (level: string) => void;
    /** Shown instead of the list when there are no levels. */
    empty?: string;
    footer?: string;
}): any;
/** The provider-picker dropdown body (keys wave-5 polish, 2026-09-21:
 *  the owner wanted the Add-provider control to match the app's dropdown
 *  language) — the same fuzzy-search + arrow-walk + Enter machine over
 *  the pi-ai provider table. Rows read: provider label, its env var in
 *  quiet mono on the right. */
export declare function ProviderMenuList({ providers, onPick, }: {
    providers: {
        id: string;
        envVar: string;
        label: string;
    }[];
    onPick: (provider: {
        id: string;
        envVar: string;
        label: string;
    }) => void;
}): any;
/** The reading-font dropdown's row set — the SAME fuzzy + arrow-walk +
 *  Enter machine over font families (appearance wave, 2026-09-26). The
 *  DEFAULT row (null) is a candidate like any family: it matches empty
 *  and "source"/"sans"/"default" queries, so an unfiltered list opens
 *  with the default first and a searched list drops it honestly — Enter
 *  can never pick a row that isn't on screen. Pure — exported for
 *  tests. */
export declare function fontMenuResults(query: string, families: string[]): Array<string | null>;
/** The custom-family action row's decision (pure, 2026-09-26): a typed
 *  query that matches NO family becomes the "Use '<query>'" custom pick —
 *  a matching family is the better pick, so the action row only exists
 *  when there is nothing else to pick. Exported for tests. */
export declare function customFamilyFor(query: string, families: string[]): string | null;
/** The reading-font dropdown body — ONE search field (owner ask
 *  2026-09-26: "why two?"): the fuzzy machine filters the families, and
 *  when nothing matches, a "Use '<query>'" action row commits the typed
 *  text as a custom family — the old separate custom input is gone, the
 *  search field absorbed its job. `families === undefined` is the
 *  enumerating state; the curated fallback arrives as plain families with
 *  a footer that says so honestly. */
export declare function FontMenuList({ families, effectiveFamily, onPick, footer, }: {
    /** Enumerated font families (already deduped/sorted by the caller);
     *  undefined while the enumeration runs. */
    families: string[] | undefined;
    /** The stored override (null = the factory Source Sans 3). */
    effectiveFamily: string | null;
    /** Receives the pick: a family string, or null for the default. */
    onPick: (family: string | null) => void;
    /** Quiet footer note under the list. */
    footer?: string;
}): any;
//# sourceMappingURL=model-menu.d.ts.map