export declare const METER_TICK_MS = 60;
/** Rolling history: 48 cells × 60ms ≈ 2.9s of recent loudness. */
export declare const METER_CELLS = 48;
/** The Deepgram key's id in the keys store (the env-var name — the Keys
 *  section's openRow state and the PUT /api/keys/:id seam). */
export declare const DEEPGRAM_KEY_ID = "DEEPGRAM_API_KEY";
/** The client-authored KEYLESS line (zero-keys wave, owner 2026-09-25):
 * the token route's raw 503 message is dev-speak ("add it to auth.json
 * (desktop) or .env.local (dev)") — the surface says the short truth
 * instead. Exported for pins; the errored idle button's click recognizes
 * it and deep-links Settings → Keys → the Deepgram row. */
export declare const DICTATION_KEYLESS = "Dictation needs a Deepgram key";
/** Warm-token cache (mitigation D, owner 2026-09-27): the click path takes
 *  the cached promise instead of a remote mint. TTL keeps a cached token
 *  from going stale (self-heal anyway: a rejected handshake rides the
 *  reconnect-once path with a FRESH mint); a failed mint resets the cache
 *  so the next call re-mints — the honest error path stays honest.
 *  refresh() re-mints in the background (page mount, run end); its
 *  failures are silently tolerated (a keyless pre-mint just doesn't warm). */
export declare const WARM_TOKEN_TTL_MS: number;
export type WarmMinter = {
    mint: () => Promise<string>;
    refresh: () => void;
};
export declare function createWarmMinter(mint: () => Promise<string>, now?: () => number, ttlMs?: number): WarmMinter;
/** RMS (0..1) → normalized 0..1 across the audible dB window. */
export declare function rmsToMeter(rms: number): number;
export declare function isDictationActive(): boolean;
/** Finish any live dictation run before continuing (see Dictation.finish). */
export declare function finishDictation(): Promise<void>;
/** Join a dictated final onto the current text (shared separator rule). */
export declare function joinDictation(current: string, final: string): string;
/**
 * Claim the dictation target while mounted (and `claimed` is true). The
 * unmount guard is identity-based so dev-mode double-invoked effects
 * can't clear another claimant.
 */
export declare function useDictationTarget(append: (text: string) => void, claimed: boolean): void;
export type DictationPhase = "idle" | "connecting" | "recording" | "stopping";
export type Dictation = {
    phase: DictationPhase;
    /** Terminal-state explanation, shown inside the wide button (cleared on the next start). */
    error: string | null;
    /** Latest observed RMS, 0..1 — sampled by the meter's own tick, never reset. */
    levelRef: {
        current: number;
    };
    /** Not idle — from the click until the stop completes (the optimistic window). */
    active: boolean;
    /** End + KEEP the transcript: flush the deferred buffer into the primary
     *  input (the Stop pill and ⌘D). */
    toggle: () => void;
    stop: () => void;
    /** FINISH, THEN CONTINUE (owner, 2026-10-01 "nothing gets lost" round):
     *  if a run is live, stop it and resolve only when the run has fully
     *  ended — Deepgram's last finals have landed in the target field. A
     *  submit path awaits this before building its payload, so a learner
     *  who forgets to stop dictation before Enter never loses the spoken
     *  reasoning. Idle → resolves immediately (the common no-run submit
     *  pays nothing). Every terminal path runs cleanup(), and cleanup()
     *  resolves the waiters — cancel (Esc) resolves them too, by its
     *  discard semantics. */
    finish: () => Promise<void>;
    /** End + DISCARD the transcript: no flush, immediate teardown. The Esc
     *  semantics (owner, 2026-09-17 round 3): Esc is a cancel, not a stop —
     *  before, it flushed exactly like the toggle did. */
    cancel: () => void;
    /** Clear the terminal error without starting a run (zero-keys wave):
     * the keyless click leaves for Settings and the surface must come
     * back clean. */
    clearError: () => void;
};
/**
 * One dictation instance per composer-bearing page. `append` is the
 * composer fallback; the mounted question form's claim wins while a
 * question waits.
 */
export declare function useDictation({ append }: {
    append: (text: string) => void;
}): Dictation;
/**
 * The stats-bar dictation slot (owner placement, round 1): the row's middle
 * is one strip that is always the full free width —
 *
 *   idle      a wide, quiet "Dictate" button (mic + label, grayed out — the
 *             whole middle is the affordance, per the owner).
 *   active    optimistic from the CLICK: red stop pill + the fixed-width
 *             meter (no interim text ever shifts it). Spinner while
 *             Deepgram flushes the last final.
 *   error     the wide button again, label swapped for the failure reason
 *             (full text in the tooltip), cleared on the next click.
 */
export declare function DictationBar({ dictation }: {
    dictation: Dictation;
}): any;
//# sourceMappingURL=dictation.d.ts.map