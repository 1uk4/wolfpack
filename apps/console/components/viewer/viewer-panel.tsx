"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, PinIcon, XIcon } from "lucide-react";
import { pinView, unpinView, usePinnedViews } from "@/components/thread/pin-store";
import { viewKey, type ViewDescriptor } from "./view-descriptor";
import { Button } from "@/components/ui/button";
import { usePanelHost, usePanelState } from "@/components/shell/panel-host";
import "./register-renderers";
import { getViewRenderer } from "./registry";
import { useViewer } from "./viewer-store";
import { useViewerUrlSync } from "./viewer-url";

const typing = (t: EventTarget | null) => {
	const el = t as HTMLElement | null;
	return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable === true);
};

/** Header toggle: pins the shown view for the thread (storing its title for the chip) or unpins it. */
export function PinViewButton({ threadId, descriptor, title }: { threadId: string; descriptor: ViewDescriptor; title: string }) {
	const pinned = usePinnedViews(threadId).some((p) => viewKey(p) === viewKey(descriptor));
	return (
		<Button
			variant="ghost"
			size="icon"
			aria-label={pinned ? "Unpin view" : "Pin view"}
			aria-pressed={pinned}
			data-testid="viewer-pin"
			onClick={() => (pinned ? unpinView(threadId, descriptor) : pinView(threadId, { kind: descriptor.kind, id: descriptor.id, title }))}
		>
			<PinIcon className={pinned ? "fill-current" : undefined} />
		</Button>
	);
}

/**
 * The thread page's right-hand viewer: a 480px column on md+, a full-screen sheet below. One right column at a time:
 * opening it closes the status (memory) panel, and opening that panel closes the viewer (the stack is kept).
 */
export function ViewerPanel({ wolf, threadId }: { wolf: string; threadId: string }) {
	const v = useViewer(wolf, threadId);
	useViewerUrlSync(wolf, threadId);
	const host = usePanelHost();
	const { open: panelOpen } = usePanelState();
	const top = v.stack[v.stack.length - 1];
	const shown = v.open && !!top;
	const [titles, setTitles] = useState<Record<string, string>>({});
	const closeViewer = v.closeViewer;

	// Exclusivity. The viewer opening closes the panel; the panel opening while the viewer is open closes the viewer.
	const prev = useRef({ shown: false, panelOpen });
	useEffect(() => {
		const p = prev.current;
		prev.current = { shown, panelOpen };
		if (!shown || !panelOpen) return;
		if (!p.shown) host.closePanel();
		else if (!p.panelOpen) closeViewer();
	}, [shown, panelOpen, host, closeViewer]);
	// On load the panel host restores its stored open flag after this mounts: a restored viewer wins.
	const live = useRef({ shown, panelOpen });
	live.current = { shown, panelOpen };
	useEffect(() => {
		const t = setTimeout(() => {
			if (live.current.shown && live.current.panelOpen) host.closePanel();
		}, 0);
		return () => clearTimeout(t);
	}, [host]);

	useEffect(() => {
		if (!shown) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" && !e.defaultPrevented && !typing(e.target)) closeViewer();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [shown, closeViewer]);

	const onTitle = useCallback((key: string, t: string) => setTitles((m) => (m[key] === t ? m : { ...m, [key]: t })), []);

	if (!shown || !top) return null;
	const Renderer = getViewRenderer(top.kind);
	const key = `${top.kind}:${top.id}`;
	const title = top.title ?? titles[key] ?? top.id;
	return (
		<aside
			className="relative flex w-[480px] shrink-0 flex-col border-l border-border bg-background text-sm max-md:fixed max-md:inset-0 max-md:z-[60] max-md:w-full max-md:border-l-0 max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)]"
			data-testid="viewer-panel"
			data-kind={top.kind}
		>
			<div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
				{v.stack.length > 1 && (
					<Button variant="ghost" size="icon" aria-label="Back" data-testid="viewer-back" onClick={v.backView}>
						<ArrowLeftIcon />
					</Button>
				)}
				<span className="min-w-0 flex-1 truncate font-medium" data-testid="viewer-title">{title}</span>
				<PinViewButton threadId={threadId} descriptor={top} title={title} />
				<Button variant="ghost" size="icon" aria-label="Close viewer" data-testid="viewer-close" onClick={closeViewer}>
					<XIcon />
				</Button>
			</div>
			<div className="min-h-0 flex-1 overflow-hidden">
				<Renderer key={key} descriptor={top} onPush={v.pushView} onTitle={(t) => onTitle(key, t)} onClose={closeViewer} />
			</div>
		</aside>
	);
}
