"use client";
import { useSyncExternalStore } from "react";
import { localEyeStore, readEyeOpen, subscribeEye, writeEyeOpen } from "@/src/core/ui/bar-eye";

/** The eye's open state, live across every bar and row that reads it. */
export function useEyeOpen(): [boolean, (open: boolean) => void] {
	const open = useSyncExternalStore(subscribeEye, () => readEyeOpen(localEyeStore()), () => false);
	return [open, (v) => writeEyeOpen(localEyeStore(), v)];
}
