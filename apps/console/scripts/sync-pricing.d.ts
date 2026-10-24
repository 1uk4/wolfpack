/**
 * Regenerate src/core/prices.ts tables from pi-ai's shipped per-provider
 * catalogs (providers/data/*.json).
 *
 * Usage: npx tsx scripts/sync-pricing.ts
 *
 * The catalogs are pi-ai's curated, versioned snapshots — the SAME source
 * piEngineFor resolves engines from and /api/models serves the picker
 * from — so the money channel's lookup table can never disagree with the
 * engine. Fully offline (the JSON ships in node_modules); refreshes happen
 * by bumping @earendil-works/pi-ai and re-running this script. The tables
 * are generated; hand edits are overwritten. A model missing from the
 * catalogs gets no entry — cost renders as absent ("—"), never zero.
 *
 * Key format (model slots wave, 2026-09-20): uniformly provider-qualified
 * ("provider:id", incl. "openrouter:<slug>"). Owner decision: no legacy
 * compat — records stamped with pre-wave bare slugs simply render unpriced.
 */
/** One raw catalog entry (fields we consume; the files carry more). */
interface CatalogModel {
    id: string;
    name: string;
    /** pi-ai 1.0 (catalog schema v6): every entry is type-tagged. */
    type?: "chat" | "image" | "classifier";
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
}
/** The pure walk: every catalog entry that carries pricing, keyed
 *  "provider:id". Exported for the drift-guard test (tests/prices-sync)
 *  so the guard asserts EXACTLY what this script would generate — the
 *  test and the generator can never disagree (owner, 2026-09-29). */
export declare function buildPrices(): Map<string, CatalogModel["cost"]>;
export {};
//# sourceMappingURL=sync-pricing.d.ts.map