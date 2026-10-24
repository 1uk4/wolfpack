import type { AuthKeyStatus } from "@/src/core";
import { type ProviderKeyInfo } from "@/components/settings/keys-section";
import type { ModelCatalogResponse } from "@/src/core";
/** Pure: does a MODEL-PROVIDER key exist among the statuses? Reuses
 *  classifyKeys (the keys section's own classification — no drift):
 *  a status whose id is a provider env-var (or the pre-interlude
 *  fallback shape) with present=true counts, present or file-sourced,
 *  env-owned included (env wins but it EXISTS). Exported for pins. */
export declare function hasProviderKey(statuses: readonly AuthKeyStatus[], providers: readonly ProviderKeyInfo[] | undefined): boolean;
/** The zero-keys truth for the calling page: TRUE only after a
 *  successful read says no provider key exists (pending and failed
 *  reads render nothing — the pill must never flash on a gap, and a
 *  failed read claiming "zero keys" would be a lie the CTA flow then
 *  leans on). Re-reads on the keys signal. */
export declare function useZeroKeys(): boolean;
/** The pill itself — the models CTA's chrome and placement, the keys
 *  chain's copy. testid "setup-cta-keys" (the models CTA keeps
 *  "setup-cta"; probes can tell them apart). */
export declare function ZeroKeysPill({ onOpen, inline }: {
    onOpen: () => void;
    inline?: boolean;
}): any;
/** Pure: the strong slot is pinned to a provider whose key is GONE (owner
 *  interlude, 2026-09-25 — the original deleted-key scenario). The catalog
 *  already knows both halves: slots.strong is the resolved pin, providers[]
 *  lists only PRESENT-key providers (keyless ones are absent, the same
 *  discipline as the search engines). False when the strong slot is unset
 *  (the models guard owns that case — this check only runs when slots ARE
 *  configured) or the catalog hasn't loaded (the server gate remains the
 *  belt). Exported for pins. */
export declare function strongKeyless(catalog: ModelCatalogResponse | undefined): boolean;
/** The strong-slot keyless truth for the PRE-SEND guard (home / /chat/new):
 *  the catalog seam with re-reads on BOTH signals that can flip it — "keys"
 *  (a provider key saved or deleted) and "models" (the strong slot
 *  re-pinned). Live-updates with the page, never mid-send. */
export declare function useStrongKeyless(): boolean;
//# sourceMappingURL=setup-cta.d.ts.map