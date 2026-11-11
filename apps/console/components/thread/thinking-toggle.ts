"use client";

import { useEffect, useState } from "react";
import { kbdEventForAction } from "@/src/core";

/** ⌘T on the thread routes (toggle-user-thinking, same action the legacy
 *  chat answered): flip EVERY reasoning block in the view to one state.
 *  Mirrors the legacy semantics — session-ephemeral, not persisted; null =
 *  "blocks run their own default" (collapsed), the first ⌘T opens all and
 *  then alternates. An explicit set stomps individual toggles (the epoch
 *  remounts the blocks), and late-arriving blocks honor the last set. */
export function useAllThinkingToggle(): { allOpen: boolean | null; epoch: number } {
	const [state, setState] = useState<{ allOpen: boolean | null; epoch: number }>({ allOpen: null, epoch: 0 });
	useEffect(() => {
		const onToggle = () => setState((s) => ({ allOpen: !(s.allOpen ?? false), epoch: s.epoch + 1 }));
		const name = kbdEventForAction("toggle-user-thinking");
		window.addEventListener(name, onToggle);
		return () => window.removeEventListener(name, onToggle);
	}, []);
	return state;
}
