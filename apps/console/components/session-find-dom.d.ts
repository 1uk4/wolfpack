export declare function sessionFindRanges(scope: HTMLElement, query: string): Range[];
/** Frozen boundary identity, rather than a mutable live Range, survives text
 * appends while Find is open. A re-render may replace nodes; then the caller
 * clamps the old index without pulling the reader to a different passage. */
export interface SessionRangeIdentity {
    start: Node;
    startOffset: number;
    end: Node;
    endOffset: number;
}
export declare function sessionRangeIdentity(range: Range): SessionRangeIdentity;
export declare function sameSessionRange(range: Range, identity: SessionRangeIdentity | null): boolean;
//# sourceMappingURL=session-find-dom.d.ts.map