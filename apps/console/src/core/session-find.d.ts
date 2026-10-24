/** Literal, case-insensitive session Find (owner, 2026-10-13). The DOM seam
 * supplies only displayed text; no transcript/Markdown/TeX indexing lives here. */
export interface SessionTextMatch {
    start: number;
    end: number;
}
export declare function findSessionTextMatches(text: string, query: string): SessionTextMatch[];
export declare function stepSessionMatch(index: number, count: number, direction: 1 | -1): number;
//# sourceMappingURL=session-find.d.ts.map