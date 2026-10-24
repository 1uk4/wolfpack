/**
 * Home — the knowledge graph is the main view, full-bleed edge to edge
 * (owner, graph-view round 1): the canvas owns the whole column, running
 * under the header and the new-session dock, both of which float over it
 * with no gradient scrims. Sessions live in the toggleable sidebar.
 */
export declare function Home({ initialConfigured, rendering, }: {
    initialConfigured: boolean;
    /** GRAPH RENDERING off (owner, 2026-10-06): the home's main view is
     * the chains view, not the canvas. Read server-side per navigation —
     * changing the setting applies on the next visit home. */
    rendering?: boolean;
}): any;
//# sourceMappingURL=home.d.ts.map