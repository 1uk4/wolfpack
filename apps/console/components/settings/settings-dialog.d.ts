/** Owner (2026-09-20): hints earn their place — mechanics-explaining
 *  prose is out; only the keyboard note stays (storage location is a
 *  real question users ask). */
declare const SECTIONS: readonly [{
    readonly id: "general";
    readonly label: "General";
}, {
    readonly id: "keys";
    readonly label: "Keys";
}, {
    readonly id: "agent";
    readonly label: "Agent";
}, {
    readonly id: "appearance";
    readonly label: "Appearance";
}, {
    readonly id: "graph";
    readonly label: "Graph";
}, {
    readonly id: "keyboard";
    readonly label: "Keyboard";
    readonly hint: "Stored on this device";
}];
type SectionId = (typeof SECTIONS)[number]["id"];
/** AppShell-level mount: the sidebar row and the mod+, chord call this.
 *  `open(section)` lands the dialog on a specific section (the first-run
 *  setup flow deep-links to Keys when no provider key exists yet). */
/** The auto-update row's hint (tooltip wave): honest user language — no
 *  stream vocabulary. Exported for the copy pin (tooltip-mechanism test). */
export declare const AUTO_UPDATE_HINT = "Automatic updates arrive in an upcoming release";
export declare function SettingsDialogProvider({ children, }: {
    children: React.ReactNode;
}): any;
export declare function useSettingsDialog(): any;
/** The dialog without the portal/backdrop — the SSR-testable frame
 *  (portals render nothing under renderToStaticMarkup). */
export declare function SettingsDialogBody({ onClose, initialSection, initialRow, }: {
    onClose: () => void;
    initialSection?: SectionId;
    /** The keys row to unfold on arrival (null = none). While-open
     *  retargets follow it exactly like initialSection below. */
    initialRow?: string | null;
}): any;
export {};
//# sourceMappingURL=settings-dialog.d.ts.map