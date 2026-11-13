"use client";
/**
 * Pack > This device (work-wolfpack-5lSw5c1). On every device: appearance and keyboard, stored on this device (the Settings dialog's own
 * components and storage). Only in the Mac app (the desktop bridge exists): folders with Show in Finder, Open at login, Copy diagnostics
 * and Reset app. Reset moves only Chromium cache folders to the Trash; wolves, keys, sign-in (the hub token lives in localStorage), drafts,
 * keyboard bindings and the knowledge base are never touched.
 */
import { useEffect, useState } from "react";
import { useAppBridge, type AppBridge } from "@/components/settings/app-bridge";
import { AppearanceSection } from "@/components/settings/appearance-section";
import { KeyboardSection } from "@/components/settings/keyboard-section";
import { useAppearance } from "@/components/settings/appearance";
import { SettingsGroup, SettingsRow, Toggle } from "@/components/settings/controls";
import { CURRENT_SETTINGS_VERSION, type AppearanceSettings, type UserSettings } from "@/src/core";

const BTN = "min-h-11 rounded-sm border border-border px-3 font-ui text-sm transition-colors hover:bg-accent disabled:opacity-40 md:min-h-8";

export function MacAppGroups({ bridge }: { bridge: AppBridge }) {
	const [paths, setPaths] = useState<{ state: string; wolves: string; logs?: string } | null>(null);
	const [login, setLogin] = useState<{ openAtLogin: boolean; needsApproval: boolean } | null>(null);
	const [copied, setCopied] = useState<string | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [resetError, setResetError] = useState<string | null>(null);
	const [resetNote, setResetNote] = useState<string | null>(null);
	const [folderError, setFolderError] = useState<string | null>(null);
	const openFolder = (name: "state" | "wolves" | "logs") => {
		setFolderError(null);
		void bridge
			.showFolder(name)
			.then((r) => {
				if (!r.ok) setFolderError(r.error ?? "Couldn't open the folder.");
			})
			.catch(() => setFolderError("Couldn't open the folder."));
	};

	useEffect(() => {
		void bridge.folders().then(setPaths).catch(() => {});
		void bridge.loginItem.get().then(setLogin).catch(() => {});
	}, [bridge]);

	return (
		<>
			<SettingsGroup label="Folders" testid="this-device-folders">
				<SettingsRow label="App data" hint={paths?.state ?? "…"}>
					<button type="button" className={BTN} onClick={() => openFolder("state")}>Show in Finder</button>
				</SettingsRow>
				<SettingsRow label="Your wolves" hint={paths?.wolves ?? "…"}>
					<button type="button" data-testid="this-device-wolves-button" className={BTN} onClick={() => openFolder("wolves")}>Show in Finder</button>
				</SettingsRow>
				{paths?.logs && (
					<SettingsRow label="Logs" hint={paths.logs}>
						<button type="button" data-testid="this-device-logs-button" className={BTN} onClick={() => openFolder("logs")}>Show in Finder</button>
					</SettingsRow>
				)}
				{folderError && <p role="alert" className="text-xs text-red-500">{folderError}</p>}
			</SettingsGroup>
			<SettingsGroup label="Open at login" testid="this-device-login">
				<SettingsRow label="Open Wolfpack when I log in" hint={login?.needsApproval ? "Needs your OK in System Settings > General > Login Items." : undefined}>
					<Toggle label="Open Wolfpack when I log in" checked={login?.openAtLogin ?? false} disabled={!login} onChange={(on) => void bridge.loginItem.set(on).then(setLogin)} />
				</SettingsRow>
			</SettingsGroup>
			<SettingsGroup label="Support" testid="this-device-support">
				<div className="flex flex-wrap items-center gap-3">
					<button
						type="button"
						className={BTN}
						onClick={() => void bridge.copyDiagnostics().then((r) => setCopied(r.ok ? "Copied" : (r.error ?? "Couldn't copy"))).catch(() => setCopied("Couldn't copy"))}
					>
						Copy diagnostics
					</button>
					{copied && <span role="status" className="text-xs text-muted-foreground">{copied}</span>}
				</div>
				<p className="text-xs text-muted-foreground">Keys and tokens are removed where they can be recognised.</p>
			</SettingsGroup>
			{bridge.resetAppUi && (
				<SettingsGroup label="Reset app" testid="this-device-reset">
					<p className="text-xs text-muted-foreground">Moves this app's caches to the Trash and restarts the app. Your wolves, keys, knowledge base, sign-in, drafts and keyboard bindings stay as they are.</p>
					<div>
						<button type="button" data-testid="this-device-reset-button" className={BTN} onClick={() => (setResetError(null), setResetNote(null), setConfirming(true))}>Reset app…</button>
					</div>
					{resetError && <p role="alert" data-testid="this-device-reset-error" className="text-xs text-red-500">{resetError}</p>}
					{resetNote && <p role="status" data-testid="this-device-reset-note" className="text-xs text-muted-foreground">{resetNote}</p>}
					{confirming && (
						<div role="alertdialog" aria-label="Reset app" className="rounded-sm border border-border p-3">
							<p className="text-sm">The app asks you to confirm and lists exactly what moves to the Trash. Then it restarts, and a reply a wolf is writing right now will stop.</p>
							<div className="mt-3 flex gap-2">
								<button type="button" className={BTN} onClick={() => setConfirming(false)}>Cancel</button>
								<button
									type="button"
									className={`${BTN} border-red-500/60 text-red-500`}
									onClick={() =>
										void bridge.resetAppUi?.().then((r) => {
											if (!r.ok && !r.cancelled) setResetError(r.error ?? "Couldn't reset. Nothing was changed.");
											else if (r.ok && r.note) setResetNote(r.note);
										}).catch(() => setResetError("Couldn't reset. Nothing was changed.")).finally(() => setConfirming(false))
									}
								>
									Continue
								</button>
							</div>
						</div>
					)}
				</SettingsGroup>
			)}
		</>
	);
}

export function ThisDeviceBody() {
	const bridge = useAppBridge();
	const { onAppearanceChange } = useAppearance();
	const [record, setRecord] = useState<UserSettings | null | undefined>(undefined);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		fetch("/api/settings")
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
			.then((b: { settings: UserSettings | null }) => setRecord(b.settings ?? { version: CURRENT_SETTINGS_VERSION }))
			.catch(() => setRecord(null));
	}, []);

	const writeAppearance = async (next: AppearanceSettings) => {
		setError(null);
		let res: Response;
		try {
			res = await fetch("/api/settings/appearance", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
		} catch {
			return setError("appearance: couldn't reach the console");
		}
		if (!res.ok) return setError(`appearance: ${res.status}`);
		setRecord((prev) => ({ ...(prev ?? { version: CURRENT_SETTINGS_VERSION }), appearance: next }) as UserSettings);
		onAppearanceChange(next);
	};

	return (
		<div data-testid="pack-this-device" className="flex flex-col gap-6">
			<section data-testid="this-device-appearance">
				<h3 className="text-sm uppercase tracking-widest">Appearance</h3>
				<p className="mt-1 text-xs text-muted-foreground">Stored on this device</p>
				{error && <p role="alert" className="mt-2 text-xs text-red-500">{error}</p>}
				<div className="mt-3">
					{record === undefined ? (
						<p className="text-xs text-muted-foreground/70">Loading…</p>
					) : record === null ? (
						<p className="text-xs text-muted-foreground/70">Appearance could not be loaded. Refresh to retry.</p>
					) : (
						<AppearanceSection appearance={record.appearance} onSectionChange={(n) => void writeAppearance(n)} />
					)}
				</div>
			</section>
			<section data-testid="this-device-keyboard">
				<h3 className="text-sm uppercase tracking-widest">Keyboard</h3>
				<p className="mt-1 text-xs text-muted-foreground">Stored on this device</p>
				<div className="mt-3">
					<KeyboardSection />
				</div>
			</section>
			{bridge && (
				<section data-testid="this-device-mac">
					<h3 className="text-sm uppercase tracking-widest">Mac app</h3>
					<div className="mt-3 flex flex-col gap-3">
						<MacAppGroups bridge={bridge} />
					</div>
				</section>
			)}
		</div>
	);
}
