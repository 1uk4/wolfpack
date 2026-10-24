/**
 * Thin settings primitives (settings-app wave): the control kit the
 * settings dialog needs. Sections → groups → rows; everything SSRs clean
 * (render tests pin the sections' markup).
 *
 * The dependency graying (owner, 2026-09-20) follows the graph viewer's
 * render-panel convention: the WHOLE row dims (opacity-40, label and
 * control together) and the control itself locks — the row owns the dim.
 */
import { type ReactNode } from "react";
/** A section block: pronounced mono heading + content. */
export declare function SettingsSection({ title, hint, children, testid, }: {
    title: string;
    /** One quiet line under the header — only where it earns its place. */
    hint?: string;
    children: React.ReactNode;
    testid?: string;
}): any;
/** A labeled sub-group inside a section (owner, 2026-09-20: clear
 *  separation — Models / Tools / Prompts read as three blocks). */
export declare function SettingsGroup({ label, children, testid, }: {
    label: string;
    children: React.ReactNode;
    testid?: string;
}): any;
/** One label + one control. Label left (with optional muted hint), control
 *  right — the settings row shape. */
export declare function SettingsRow({ label, hint, children, testid, dimmed, }: {
    label: string;
    hint?: string;
    children: React.ReactNode;
    testid?: string;
    /** Dependency graying, graph-view style: the whole row dims when the
     *  control is inert (parent off, no file yet, …). */
    dimmed?: boolean;
}): any;
/** The on/off switch — a plain button in the switch role. */
export declare function Toggle({ checked, disabled, onChange, label, discIcon, title, }: {
    checked: boolean;
    disabled?: boolean;
    onChange: (next: boolean) => void;
    /** Accessible name for the switch role. */
    label: string;
    /** Optional icon disc (owner round, 2026-10-07): the figure cards' invert
     *  toggle renders the half-filled contrast circle AS the disc — the icon
     *  carries the meaning; plain toggles keep the plain disc. */
    discIcon?: ReactNode;
    /** Optional native tooltip on the switch. */
    title?: string;
}): any;
/** A thin select — native element, options as given. */
export declare function ThinSelect({ value, onChange, children, ariaLabel, testid, disabled, }: {
    value: string;
    onChange: (next: string) => void;
    children: React.ReactNode;
    ariaLabel: string;
    testid?: string;
    disabled?: boolean;
}): any;
/** A thin hex/text input committing on blur + Enter (settings pace, not
 *  typing pace — every commit is a section PUT). */
export declare function CommitInput({ value, placeholder, onCommit, ariaLabel, testid, type, }: {
    /** "" = unset (the factory default). Mirrors the STORED record —
     *  after a clamped/normalized commit this flows back and the field
     *  snaps to the stored truth (owner repro: a negative size kept
     *  displaying "-5" while 12 was stored). */
    value: string;
    placeholder?: string;
    onCommit: (next: string) => void;
    ariaLabel: string;
    testid?: string;
    type?: "text" | "number";
}): any;
//# sourceMappingURL=controls.d.ts.map