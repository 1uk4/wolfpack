/**
 * Cluster color identity — pure presentation math for the knowledge-graph
 * regions. (The hull geometry that used to live here — convexHull,
 * outwardNormal, offsetPolygon, traceRoundedPath — was RETIRED with the
 * convex-hull renderer: regions are now a low-res world-space splat
 * bitmap in graph-canvas.ts, which renders concave cluster shapes
 * correctly and costs one blit per frame instead of 32 clusters × 4
 * offset polygons. The file keeps the name for the barrel imports.)
 */

export type Pt = { x: number; y: number };

