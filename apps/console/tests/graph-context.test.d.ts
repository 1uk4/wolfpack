/**
 * THE GRAPH-CONTEXT MARKER (owner, 2026-10-04 late): a session started
 * with map picks gets its context as a SEPARATE custom message BEFORE
 * the learner's first user message — the picked propositions plus the
 * reasoning chains among them (formatChainLine lines), no more seed
 * text glued into the opening prompt. The model reads the marker's
 * content (toLlmMessages flattens it to a user message like every
 * marker); `details` feeds the transcript's collapsible
 * GraphContextCard (render-practice pins live in the render suite).
 *
 * The route pin drives POST /api/chats under an isolated LH_DATA_DIR
 * (the birth-stamp discipline): picks ride the CREATION, the marker
 * lands as message[0], and the chains derive from the live graph
 * snapshot.
 */
export {};
//# sourceMappingURL=graph-context.test.d.ts.map