import { type AppearanceSettings, type GraphSettings } from "@/src/core";
/** The factory reading family — the DEFAULT row's identity (unset =
 *  this). Exported for tests. */
export declare const DEFAULT_READING_FONT = "Source Sans 3";
/** The dev-browser fallback list (queryLocalFonts is absent there):
 *  the app's own knowns plus a handful of ubiquitous macOS families,
 *  honestly LABELED as common — never presented as the system's real
 *  list. The factory family is absent: the DEFAULT row is it. Exported
 *  for tests. */
export declare const CURATED_FALLBACK_FONTS: readonly string[];
/** Compose the reading-font pick: null (or blank) = the factory
 *  Source Sans 3; otherwise the family verbatim (trimmed — the
 *  sanitizer trims again server-side). Pure — exported for tests. */
export declare function composeFontFamily(appearance: AppearanceSettings | undefined, family: string | null): AppearanceSettings;
export declare function AppearanceSection({ appearance, onSectionChange, }: {
    /** The record's appearance delta (absent = factory). */
    appearance: AppearanceSettings | undefined;
    /** PUT the whole appearance section; the page re-applies on success. */
    onSectionChange: (next: AppearanceSettings) => void;
}): any;
export declare function GraphSection({ graph, onSectionChange, }: {
    graph: GraphSettings | undefined;
    onSectionChange: (next: GraphSettings) => void;
}): any;
//# sourceMappingURL=appearance-section.d.ts.map