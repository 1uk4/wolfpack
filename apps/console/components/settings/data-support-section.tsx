"use client";
/**
 * Settings > Data and support (single-Mac app only, work-wolfpack-B97I0Gv): where the files are, open at login, change the API key,
 * copy diagnostics for support, and reset the app. All the work happens in the desktop app's main process via the bridge.
 */
import { useEffect, useState } from "react";
import { SettingsGroup, SettingsRow, Toggle } from "./controls.tsx";
import type { AppBridge, Result } from "./app-bridge.ts";

const BTN = "min-h-11 rounded-sm border border-border px-3 font-ui text-sm transition-colors hover:bg-accent disabled:opacity-40 md:min-h-8";

function PathRow({ label, path, onShow }: { label: string; path: string; onShow: () => void }) {
	return (
		<SettingsRow label={label} hint={path}>
			<button type="button" className={BTN} onClick={onShow}>
				Show in Finder
			</button>
		</SettingsRow>
	);
}

export function DataSupportSection({ bridge }: { bridge: AppBridge }) {
	const [paths, setPaths] = useState<{ state: string; wolves: string } | null>(null);
	const [login, setLogin] = useState<{ openAtLogin: boolean; needsApproval: boolean } | null>(null);
	const [key, setKey] = useState("");
	const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState<string | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [resetError, setResetError] = useState<string | null>(null);
	const [resetting, setResetting] = useState(false);

	useEffect(() => {
		void bridge.folders().then(setPaths).catch(() => {});
		void bridge.loginItem.get().then(setLogin).catch(() => {});
	}, [bridge]);

	const saveKey = async () => {
		setBusy(true);
		setKeyMsg(null);
		const r: Result = await bridge.changeKey(key).catch(() => ({ ok: false, error: "Something went wrong. Try again." }));
		setBusy(false);
		if (r.ok) {
			setKey(""); // the field is cleared; the key is not kept on the page
			setKeyMsg({ ok: true, text: "Key saved. Your wolf restarted with it." });
		} else if (r.cancelled) {
			setKeyMsg(null);
		} else setKeyMsg({ ok: false, text: r.error ?? "Something went wrong. Try again." });
	};

	return (
		<>
			<SettingsGroup label="Folders" testid="data-folders">
				<PathRow label="App data" path={paths?.state ?? "…"} onShow={() => void bridge.showFolder("state")} />
				<PathRow label="Your wolves" path={paths?.wolves ?? "…"} onShow={() => void bridge.showFolder("wolves")} />
			</SettingsGroup>

			<SettingsGroup label="Open at login" testid="data-login">
				<SettingsRow
					label="Open Wolfpack when I log in"
					hint={login?.needsApproval ? "Needs your OK in System Settings > General > Login Items." : undefined}
				>
					<Toggle
						label="Open Wolfpack when I log in"
						checked={login?.openAtLogin ?? false}
						disabled={!login}
						onChange={(on) => void bridge.loginItem.set(on).then(setLogin)}
					/>
				</SettingsRow>
			</SettingsGroup>

			<SettingsGroup label="Anthropic API key" testid="data-key">
				<div className="flex flex-wrap items-center gap-2">
					<input
						type="password"
						autoComplete="off"
						spellCheck={false}
						aria-label="New API key"
						placeholder="Paste a new API key"
						value={key}
						onChange={(e) => setKey(e.target.value)}
						className="min-h-11 min-w-0 flex-1 rounded-sm border border-border bg-transparent px-3 font-ui text-sm md:min-h-8"
					/>
					<button type="button" className={BTN} disabled={busy || !key.trim()} onClick={() => void saveKey()}>
						{busy ? "Checking…" : "Save"}
					</button>
				</div>
				<p className="text-xs text-muted-foreground">Your wolf restarts. A reply in progress stops.</p>
				{keyMsg && (
					<p role={keyMsg.ok ? "status" : "alert"} className={`text-xs ${keyMsg.ok ? "text-muted-foreground" : "text-red-500"}`}>
						{keyMsg.text}
					</p>
				)}
			</SettingsGroup>

			<SettingsGroup label="Support" testid="data-support">
				<div className="flex flex-wrap items-center gap-3">
					<button
						type="button"
						className={BTN}
						onClick={() =>
							void bridge
								.copyDiagnostics()
								.then((r) => setCopied(r.ok ? "Copied" : (r.error ?? "Couldn't copy")))
								.catch(() => setCopied("Couldn't copy"))
						}
					>
						Copy diagnostics
					</button>
					{copied && <span role="status" className="text-xs text-muted-foreground">{copied}</span>}
				</div>
				<p className="text-xs text-muted-foreground">Keys and tokens are removed before anything is copied.</p>
			</SettingsGroup>

			<SettingsGroup label="Reset" testid="data-reset">
				<div>
					<button type="button" className={BTN} disabled={resetting} onClick={() => (setResetError(null), setConfirming(true))}>
						Reset app… (keeps your wolves)
					</button>
				</div>
				{resetting && <p role="status" className="text-xs text-muted-foreground">Resetting…</p>}
				{resetError && <p role="alert" className="text-xs text-red-500">{resetError}</p>}
				{confirming && (
					<div role="alertdialog" aria-label="Reset app" className="rounded-sm border border-border p-3">
						<p className="text-sm">
							Your settings, key and knowledge base move to the Trash, so you can still get them back from there. Your wolves in ~/Wolves stay where they are, with their memory. Setup starts again.
						</p>
						<div className="mt-3 flex gap-2">
							<button type="button" className={BTN} disabled={resetting} onClick={() => setConfirming(false)}>
								Cancel
							</button>
							<button
								type="button"
								className={`${BTN} border-red-500/60 text-red-500`}
								disabled={resetting}
								onClick={() => {
									setResetting(true);
									void bridge
										.reset()
										.then((r) => {
											if (!r.ok && !r.cancelled) setResetError(r.error ?? "Couldn't reset. Nothing was changed.");
										})
										.catch(() => setResetError("Couldn't reset. Nothing was changed."))
										.finally(() => {
											setResetting(false);
											setConfirming(false);
										});
								}}
							>
								{resetting ? "Resetting…" : "Reset"}
							</button>
						</div>
					</div>
				)}
			</SettingsGroup>
		</>
	);
}
