"use client";
import { useEffect, useState } from "react";
import { mapAppEvent, type AppUpdaterEvent, type UpdateState } from "@wolfpack/protocol/update-state";
import { useAppBridge } from "@/components/settings/app-bridge";

/**
 * The Mac app's update state (work-wolfpack-5IZ3Xc9): seeds from the shell's last step, then reduces each pushed
 * updater step through the shared `mapAppEvent`. Null outside the desktop app, or before any step.
 */
export function useAppUpdateState(opts: { version?: string | null; channel?: "stable" | "main" | null } = {}): UpdateState | null {
	const bridge = useAppBridge();
	const [state, setState] = useState<UpdateState | null>(null);
	const { version = null, channel = null } = opts;

	useEffect(() => {
		if (!bridge?.onUpdateStatus) {
			setState(null);
			return;
		}
		let live = true;
		const apply = (e: AppUpdaterEvent) => setState((prev) => mapAppEvent(prev ?? undefined, e, { version, channel, now: Date.now() }));
		// Subscribe first so a step landing while the seed is in flight is not lost; a later push wins over the seed.
		let pushed = false;
		const off = bridge.onUpdateStatus((e) => {
			pushed = true;
			apply(e);
		});
		void bridge.getUpdateState?.().then((e) => {
			if (live && e && !pushed) apply(e);
		});
		return () => {
			live = false;
			off?.();
		};
	}, [bridge, version, channel]);

	return state;
}
