"use client";

/**
 * What's New on open (work-wolfpack-1kIm992): after an update the release notes show once, can be dismissed, and reopen from the Pack panel.
 * The Mac app tracks its own version (`desktop/v<version>`); a plain browser tracks the console's (`console/v<version>`). Nothing else pops notes.
 * The due rule and storage are pure so they test without a DOM; `WhatsNew` (mounted in the shell) and `WhatsNewButton` (the Pack) are glue.
 */
import { useEffect, useState } from "react";
import { compareVersions, isDevVersion } from "@wolfpack/protocol/updates";
import { useAppBridge } from "@/components/settings/app-bridge";
import { useAppUpdateState } from "@/components/settings/use-app-update-state";
import { ReleaseNotesDialog } from "@/components/shell/release-notes-view";

export type WhatsNewKind = "desktop" | "console";
export interface SeenStorage {
	getItem(k: string): string | null;
	setItem(k: string, v: string): void;
}

/** Due only when `running` is a real release newer than the last one seen. First run (nothing seen), same, rollback and dev builds are not due. */
export function whatsNewDue(seen: string | null, running: string): boolean {
	if (seen === null || running === "0.0.0" || isDevVersion(running)) return false;
	return compareVersions(running, seen) === 1;
}

const key = (kind: WhatsNewKind) => `wolfpack.whatsnew.seen.${kind}`;
export const whatsNewTag = (kind: WhatsNewKind, version: string) => `${kind}/v${version}`;
/** A version worth showing notes for: a real release, not a dev build. */
export const hasNotes = (version: string | null | undefined): version is string => !!version && version !== "0.0.0" && !isDevVersion(version) && compareVersions(version, "0.0.0") !== null;

export function markWhatsNewSeen(storage: SeenStorage, kind: WhatsNewKind, version: string): void {
	try {
		storage.setItem(key(kind), version);
	} catch {
		/* storage unavailable: it may show again next launch */
	}
}

/** True when the notes are due. First run stores the version silently; a rollback is left alone so the next update still compares to the higher one. */
export function checkWhatsNew(storage: SeenStorage, kind: WhatsNewKind, running: string): boolean {
	let seen: string | null = null;
	try {
		seen = storage.getItem(key(kind));
	} catch {
		return false;
	}
	if (seen === null) {
		markWhatsNewSeen(storage, kind, running);
		return false;
	}
	return whatsNewDue(seen, running);
}

const titleFor = (version: string) => `What's new in Wolfpack ${version}`;
/** Dev only: ?whatsNew=1 forces the dialog for a real tag, since a dev build's own version has no notes. */
const DEV_TAG = "console/v0.1.27-main.5";

async function consoleRunning(): Promise<string | null> {
	try {
		const r = await fetch("/api/updates");
		const b = r.ok ? ((await r.json()) as { components?: { component: string; running: string | null }[] }) : null;
		return b?.components?.find((c) => c.component === "console")?.running ?? null;
	} catch {
		return null;
	}
}

/** WhatsNew is mounted by both the mobile and the desktop sidebar: only the first one to find notes due opens the dialog in a page view. */
let shownThisPageView = false;

export function WhatsNew() {
	const bridge = useAppBridge();
	const app = useAppUpdateState();
	const [consoleV, setConsoleV] = useState<string | null>(null);
	const [open, setOpen] = useState<{ kind: WhatsNewKind; version: string; tag: string } | null>(null);
	const [checked, setChecked] = useState<string | null>(null);
	const kind: WhatsNewKind = bridge ? "desktop" : "console";
	useEffect(() => {
		if (!bridge) void consoleRunning().then(setConsoleV);
	}, [bridge]);
	const running = bridge ? (app?.current ?? null) : consoleV;
	useEffect(() => {
		if (process.env.NODE_ENV !== "production" && new URLSearchParams(window.location.search).get("whatsNew") === "1") {
			setOpen({ kind: "console", version: "0.1.27-main.5", tag: DEV_TAG });
			return;
		}
		// One check per version per page view: a failed fetch is not retried until the next view.
		if (!running || checked === running) return;
		setChecked(running);
		if (!shownThisPageView && checkWhatsNew(localStorage, kind, running)) {
			shownThisPageView = true;
			setOpen({ kind, version: running, tag: whatsNewTag(kind, running) });
		}
	}, [running, kind, checked]);
	if (!open) return null;
	return <NotesOnce tag={open.tag} version={open.version} onClose={() => (markWhatsNewSeen(localStorage, open.kind, open.version), setOpen(null))} />;
}

/** Fetches first and shows nothing when the notes are missing (the version stays unseen for next time). */
function NotesOnce({ tag, version, onClose }: { tag: string; version: string; onClose: () => void }) {
	const [ok, setOk] = useState<boolean | null>(null);
	useEffect(() => {
		let alive = true;
		void fetch(`/api/release-notes?tag=${encodeURIComponent(tag)}`)
			.then((r) => alive && setOk(r.ok))
			.catch(() => alive && setOk(false));
		return () => {
			alive = false;
		};
	}, [tag]);
	if (!ok) return null;
	return <ReleaseNotesDialog tag={tag} title={titleFor(version)} onClose={onClose} />;
}

/** The Pack's reopen button for the running version; the console kind looks its version up when none is given. */
export function WhatsNewButton({ kind, version }: { kind: WhatsNewKind; version?: string | null }) {
	const [looked, setLooked] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	useEffect(() => {
		if (kind === "console" && !version) void consoleRunning().then(setLooked);
	}, [kind, version]);
	const v = version ?? looked;
	if (!hasNotes(v)) return null;
	return (
		<>
			<button type="button" data-testid="whats-new-open" onClick={() => setOpen(true)} className="rounded-sm border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground max-md:min-h-11 max-md:px-3 max-md:py-2">
				What&apos;s new
			</button>
			{open && <ReleaseNotesDialog tag={whatsNewTag(kind, v)} title={titleFor(v)} onClose={() => setOpen(false)} />}
		</>
	);
}
