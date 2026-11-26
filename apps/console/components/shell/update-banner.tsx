"use client";

/**
 * The auto-update banner (Wave C, owner 2026-10-10: silent download +
 * restart-banner UX). The shell pushes "wolfpack:update-status" once a staged
 * update exists (electron/main.cjs update-downloaded); this is the whole
 * renderer surface — a small fixed card, bottom-right, offering Restart.
 * Browser builds have no desktop bridge and never see a push: renders null.
 *
 * No dismiss: a downloaded update installs on quit anyway
 * (autoInstallOnAppQuit); the banner is a courtesy, not a gate.
 */

import { useEffect, useState } from "react";
import { desktopBridge } from "@/components/shell/sidebar";
import { useAppUpdateState } from "@/components/settings/use-app-update-state";
import { useAppBridge } from "@/components/settings/app-bridge";

// The desktop bridge type lives in components/shell/sidebar.tsx (the incumbent
// declare-global) — onUpdateStatus/installUpdate are declared there too.

type UpdateStatus = { status: string; version: string | null };

export default function UpdateBanner() {
	const [ready, setReady] = useState<UpdateStatus | null>(null);

	useEffect(() => {
		// Absent bridge (browser / dev) → stays hidden forever.
		return desktopBridge()?.onUpdateStatus?.((s) => {
			if (s?.status === "downloaded") setReady(s);
		});
	}, []);

	// A window opened after the download gets no push: the app's seeded state says `ready` too (work-wolfpack-WIaZh5k).
	const app = useAppUpdateState();
	const appBridge = useAppBridge();
	const shown = ready ?? (app?.state === "ready" ? { status: "downloaded", version: app.latest } : null);
	if (!shown) return null;
	return (
		<div
			data-testid="update-banner"
			className="fixed right-4 bottom-4 z-50 flex items-center gap-3 rounded-lg border border-border bg-popover px-4 py-3 shadow-lg"
		>
			<div className="text-sm">
				<span className="font-medium">Wolfpack {shown.version ?? "update"} is ready</span>
				<span className="text-muted-foreground">, restart to update</span>
			</div>
			<button
				type="button"
				onClick={() => (desktopBridge()?.installUpdate ?? appBridge?.installUpdate)?.()}
				className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent/80"
			>
				Restart
			</button>
		</div>
	);
}
