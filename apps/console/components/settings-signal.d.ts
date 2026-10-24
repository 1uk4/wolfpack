export declare const SETTINGS_SAVED_EVENT = "lh:settings-saved";
/** The settings sections a writer can land (the write seam's union). */
export type SettingsSection = "general" | "keys" | "agent" | "models" | "appearance" | "graph" | "compaction";
/** Writers call this after the PUT resolves ok — never before (a failed
 *  write notifies nothing; the record is unchanged). */
export declare function notifySettingsSaved(section: SettingsSection): void;
/** Non-hook listener (imperative seams, tests). Returns an unsubscribe. */
export declare function onSettingsSaved(handler: (section: SettingsSection) => void): () => void;
/** Reader subscription: re-invokes whenever a writer lands, with the
 *  handler captured through a ref so callers never churn the
 *  subscription (and never stale-close over it either). */
export declare function useSettingsSaved(handler: (section: SettingsSection) => void): void;
//# sourceMappingURL=settings-signal.d.ts.map