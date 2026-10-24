/** The quiet centered summary — a pure body (props in, markup out) so
 * the render suite can pin it statically. Very quiet by owner ruling:
 * muted small text, no cards, no chrome. */
export declare function KnowledgeSummary({ propositions, chains, teachSessions, practiceSessions, importedNotes, }: {
    propositions: number;
    chains: number;
    teachSessions: number;
    practiceSessions: number;
    importedNotes: number;
}): any;
export declare function MinimalHome({ chainSelectOpen, practiceSelection, onPracticeSelectionChange, onChainSelectClose, }: {
    /** The lifted pick set drives the overlay's select mode (Done instead
     * of the delete fence); the chip in home's composer reflects it. */
    chainSelectOpen?: boolean;
    practiceSelection?: ReadonlySet<string>;
    onPracticeSelectionChange?: (nodes: {
        id: string;
        name: string;
        statement: string;
    }[]) => void;
    onChainSelectClose?: () => void;
}): any;
//# sourceMappingURL=minimal-home.d.ts.map