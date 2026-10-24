/**
 * Unit tests — the UI parse seam (src/core/tool-parts.ts).
 *
 * The rule born of the 2026-09-12 live crashes: model-authored tool input
 * is consumed only through these parsers, each running the SAME zod schema
 * the model faced at the boundary. These pins hold the two exact live
 * crash shapes (the model's double-encoding habit) and the boundary-parity
 * property: anything a boundary schema accepts, the display parse accepts.
 */
export {};
//# sourceMappingURL=tool-parts.test.d.ts.map