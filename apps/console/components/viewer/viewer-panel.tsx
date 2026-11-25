"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeftIcon, PinIcon, RotateCwIcon, XIcon } from "lucide-react";
import { ViewerActionsContext } from "./viewer-actions";
import { pinView, unpinView, usePinnedViews } from "@/components/thread/pin-store";
import { viewKey, type ViewDescriptor } from "./view-descriptor";
import { Button } from "@/components/ui/button";
import { usePanelHost, usePanelState } from "@/components/shell/panel-host";
import "./register-renderers";
import { getViewRenderer } from "./registry";
import { useViewer } from "./viewer-store";
import { useViewerUrlSync } from "./viewer-url";
import { hostAllows, hostStoreArgs, threadHost, type ViewerHost } from "./viewer-host";
import { clampViewerWidth, DEFAULT_VIEWER_WIDTH, readViewerWidth, writeViewerWidth } from "./viewer-width";

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
export function ViewerPanel(props: ({ wolf: string; threadId: string } | { host: ViewerHost }) & { fill?: boolean; headerExtra?: ReactNode }) {
	const viewerHost = "host" in props ? props.host : threadHost(props.wolf, props.threadId);
	const [wolf, threadId] = hostStoreArgs(viewerHost);
	const v = useViewer(wolf, threadId);
	useViewerUrlSync(wolf, threadId, viewerHost);
	const host = usePanelHost();
	const { open: panelOpen } = usePanelState();
	const top = v.stack[v.stack.length - 1];
	const shown = v.open && !!top;
	const [titles, setTitles] = useState<Record<string, string>>({});
	const closeViewer = v.closeViewer;
	// A renderer (frame) registers a reload action; the header shows Reload and a pull-down on the header/grab area calls it.
	const [reload, setReloadFn] = useState<(() => void) | null>(null);
	const actions = useMemo(() => ({ setReload: (fn: (() => void) | null) => setReloadFn(() => fn) }), []);
	const pullStart = useRef<{ x: number; y: number } | null>(null);

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

	// Desktop column width: one global stored value; the phone sheet has no handle and ignores it.
	const [desktop, setDesktop] = useState(false);
	const [width, setWidth] = useState(DEFAULT_VIEWER_WIDTH);
	useEffect(() => {
		const mq = typeof window.matchMedia === "function" ? window.matchMedia("(min-width: 768px)") : null;
		const sync = () => setDesktop(!!mq?.matches);
		sync();
		mq?.addEventListener?.("change", sync);
		return () => mq?.removeEventListener?.("change", sync);
	}, []);
	useEffect(() => setWidth(readViewerWidth(window.localStorage)), []);
	const drag = useRef<{ x: number; w: number } | null>(null);
	const widthRef = useRef(width);
	widthRef.current = width;
	const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!drag.current) return;
		drag.current = null;
		document.body.style.userSelect = "";
		e.currentTarget.releasePointerCapture?.(e.pointerId);
		writeViewerWidth(window.localStorage, widthRef.current);
	};

	const onTitle = useCallback((key: string, t: string) => setTitles((m) => (m[key] === t ? m : { ...m, [key]: t })), []);

	if (!shown || !top) return null;
	const Renderer = getViewRenderer(top.kind);
	const key = `${top.kind}:${top.id}`;
	const title = top.title ?? titles[key] ?? top.id;
	return (
		<aside
			className={`relative flex ${props.fill ? "min-w-0 flex-1" : "w-[480px] shrink-0"} flex-col border-l border-border bg-background text-sm max-md:fixed max-md:inset-0 max-md:z-[60] max-md:w-full max-md:border-l-0 max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)] ${props.fill ? "pb-28" : ""}`}
			data-testid="viewer-panel"
			data-kind={top.kind}
			data-fill={props.fill ? "true" : undefined}
			style={desktop && !props.fill ? { width } : undefined}
		>
			{desktop && !props.fill && (
				<div
					role="separator"
					aria-orientation="vertical"
					aria-label="Resize viewer"
					data-testid="viewer-resize"
					className="absolute inset-y-0 -left-[3px] z-10 w-[6px] cursor-col-resize touch-none bg-transparent transition-colors hover:bg-border active:bg-border"
					onPointerDown={(e) => {
						drag.current = { x: e.clientX, w: width };
						document.body.style.userSelect = "none";
						e.currentTarget.setPointerCapture?.(e.pointerId);
					}}
					onPointerMove={(e) => {
						if (drag.current) setWidth(clampViewerWidth(drag.current.w + drag.current.x - e.clientX, window.innerWidth));
					}}
					onPointerUp={endDrag}
					onPointerCancel={endDrag}
					onDoubleClick={() => {
						setWidth(DEFAULT_VIEWER_WIDTH);
						writeViewerWidth(window.localStorage, DEFAULT_VIEWER_WIDTH);
					}}
				/>
			)}
			<div
				className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2"
				data-testid="viewer-header"
				onTouchStart={(e) => {
					const t = e.touches[0];
					pullStart.current = reload && t ? { x: t.clientX, y: t.clientY } : null;
				}}
				onTouchEnd={(e) => {
					const p0 = pullStart.current;
					pullStart.current = null;
					const t = e.changedTouches[0];
					// A pull: more than 60px down and more than twice the sideways drift.
					if (reload && p0 && t && t.clientY - p0.y > 60 && t.clientY - p0.y > 2 * Math.abs(t.clientX - p0.x)) reload();
				}}
			>
				{v.stack.length > 1 && (
					<Button variant="ghost" size="icon" aria-label="Back" data-testid="viewer-back" onClick={v.backView}>
						<ArrowLeftIcon />
					</Button>
				)}
				<span className="min-w-0 flex-1 truncate font-medium" data-testid="viewer-title">{title}</span>
				{props.headerExtra}
				{reload && (
					<Button variant="ghost" size="icon" aria-label="Reload" data-testid="viewer-reload" onClick={reload}>
						<RotateCwIcon />
					</Button>
				)}
				{viewerHost.pins && <PinViewButton threadId={threadId} descriptor={top} title={title} />}
				<Button variant="ghost" size="icon" aria-label="Close viewer" data-testid="viewer-close" onClick={closeViewer}>
					<XIcon />
				</Button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto" data-testid="viewer-body">
				<ViewerActionsContext.Provider value={actions}>
					<Renderer key={key} descriptor={top} onPush={v.pushView} onTitle={(t) => onTitle(key, t)} onClose={closeViewer} />
				</ViewerActionsContext.Provider>
			</div>
		</aside>
	);
}
