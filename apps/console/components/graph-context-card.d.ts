/**
 * The graph-context card (owner, 2026-10-04): the session's map pick —
 * message[0] of a session started with propositions picked from the
 * graph. Scaffolding, not a turn: minimal, muted, collapsed by default;
 * expand reveals the picked propositions (name — statement) and the
 * reasoning chains among them (premises → conclusion lines). The model
 * reads the same content through the marker's own text (toLlmMessages);
 * this card is the learner's face of it.
 */
/** The graph-context marker's details (native-messages.ts). */
export interface GraphContextData {
    propositions: {
        id: string;
        name: string;
        statement: string;
    }[];
    chains: string[];
}
export declare function GraphContextCard({ data }: {
    data: GraphContextData;
}): any;
//# sourceMappingURL=graph-context-card.d.ts.map