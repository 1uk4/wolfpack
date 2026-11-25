"use client";

import { createContext, useEffect, useRef } from "react";
import { pinView } from "@/components/thread/pin-store";
import { openView, refreshView } from "@/components/viewer/viewer-store";
import { parseFrameDescriptor, type ViewDescriptor } from "@/components/viewer/view-descriptor";

/** Which thread the view card sits in (the card gets no wolf/thread props); provided by thread-chat. */
export const ViewHostContext = createContext<{ wolf: string; threadId: string } | null>(null);

/** Desktop breakpoint (px): below it the viewer is a sheet the owner opens by tapping the card. */
export const VIEWER_WIDE_PX = 768;

/** Open-on-arrival rule: only a new object/rev, on the thread that is on screen, on a wide viewport. Never steals focus otherwise. */
export function shouldOpenOnArrival(a: { isNew: boolean; onScreen: boolean; viewportWide: boolean }): boolean {
	return a.isNew && a.onScreen && a.viewportWide;
}

export interface ViewArrival {
	descriptor: ViewDescriptor;
	pinned: boolean;
}

interface ViewPartLike {
	type?: string;
	objectId?: unknown;
	objectType?: unknown;
	rev?: unknown;
	data?: unknown;
	pinned?: unknown;
}

/**
 * Folds the collapsed messages for "view" objects and returns those not yet in `seen` (keyed objectId:rev), marking all as seen.
 * When `live` is false (initial load / history replay) everything is marked seen and nothing is returned.
 */
export function viewArrivals(messages: ReadonlyArray<{ role?: string; parts?: unknown[] }>, seen: Set<string>, live: boolean, wolf?: string): ViewArrival[] {
	const out: ViewArrival[] = [];
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const p of (m.parts ?? []) as ViewPartLike[]) {
			if (p.type !== "object" || p.objectType !== "view" || typeof p.objectId !== "string") continue;
			const key = `${p.objectId}:${String(p.rev)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const d = p.data as { kind?: unknown; id?: unknown; title?: unknown } | undefined;
			if (live && d?.kind === "frame") {
				const f = parseFrameDescriptor({ ...d, rev: p.rev }, wolf);
				if (f) out.push({ descriptor: f, pinned: p.pinned === true });
				continue;
			}
			if (!live || !d || typeof d.kind !== "string" || typeof d.id !== "string") continue;
			out.push({ descriptor: { kind: d.kind, id: d.id, ...(typeof d.title === "string" ? { title: d.title } : {}) }, pinned: p.pinned === true });
		}
	}
	return out;
}

const isWide = () => typeof window !== "undefined" && (typeof window.matchMedia === "function" ? window.matchMedia(`(min-width: ${VIEWER_WIDE_PX}px)`).matches : window.innerWidth >= VIEWER_WIDE_PX);
const isVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

/**
 * Called by thread-chat (the mounted thread page) with the collapsed messages. A view that streams in while this thread
 * is on screen opens the viewer (desktop only); pinned:true also pins it. The first render and history are marked seen.
 */
export function useViewObjectArrivals(wolf: string, threadId: string, messages: ReadonlyArray<{ role?: string; parts?: unknown[] }>, streaming: boolean) {
	const seen = useRef<Set<string>>(new Set());
	const primed = useRef(false);
	useEffect(() => {
		const live = primed.current && streaming;
		primed.current = true;
		for (const a of viewArrivals(messages, seen.current, live, wolf)) {
			if (a.descriptor.kind === "frame") refreshView(wolf, threadId, a.descriptor);
			if (shouldOpenOnArrival({ isNew: true, onScreen: isVisible(), viewportWide: isWide() })) openView(wolf, threadId, a.descriptor);
			if (a.pinned) pinView(threadId, a.descriptor);
		}
	}, [messages, streaming, wolf, threadId]);
}
