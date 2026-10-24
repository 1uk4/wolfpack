import { type AuthKeyStatus } from "@/src/core";
/** One pi-ai provider with plain API-key auth (the Platform seam —
 *  derived from pi-ai's own env-key table; no drift possible). */
export interface ProviderKeyInfo {
    id: string;
    envVar: string;
    label: string;
}
/** The classification driving the table groups. Pure — exported for
 *  tests. OpenRouter is un-pinned (wave-5 owner ruling): no synthesis,
 *  no special row — it rides the same provider classification. */
export declare function classifyKeys(statuses: readonly AuthKeyStatus[], providers: readonly ProviderKeyInfo[] | undefined): {
    /** Stored provider keys (env or file), in GET order. */
    providerRows: AuthKeyStatus[];
    /** The curated tools rows (synthesized when absent — always shown,
     *  they carry the docs links a first boot needs). */
    toolRows: AuthKeyStatus[];
    /** Unknown file vars — preserved, read-only. */
    unknownRows: AuthKeyStatus[];
    /** Providers without a stored key — the Add dropdown's options. */
    addable: ProviderKeyInfo[];
};
/** The minimal status line, e.g. "…ab12 · 64 chars" (" · env" marks an
 *  environment-owned value — the row itself is read-only then). Pure. */
export declare function keyStatusLine(status: AuthKeyStatus): string;
export declare function KeysSection({ 
/** A deep-linked row to unfold on arrival (zero-keys wave): the
 *  dictation error's click lands here on DEEPGRAM_API_KEY. Followed
 *  while mounted too — the settings dialog's while-open retarget
 *  pattern. undefined = nothing seeded. */
initialRow, }: {
    initialRow?: string;
}): any;
//# sourceMappingURL=keys-section.d.ts.map