"use client";

/**
 * Image drops onto the floating chat. The bar's composer (chat-bar-composer.tsx) owns the attachments, so it registers where files go
 * (`registerBarDropSink`); the bar's outer box takes drag and drop through `useBarDrop`, and a docked bar also hands the thread page
 * its sink (`getDockedBarSink`) so a drop anywhere on the page attaches to the bar instead of the page's hidden composer.
 */
import { useEffect, useState, type DragEvent } from "react";
import { dragHasFiles, droppedFiles } from "@/components/composer/attachments";

type Sink = (files: File[]) => void;
let sink: { fn: Sink; docked: boolean } | null = null;

/** The composer says where dropped files go while it is mounted (null on unmount). `docked`: the bar is the thread page's composer. */
export function registerBarDropSink(fn: Sink | null, docked = false): void {
	sink = fn ? { fn, docked } : null;
}

/** The bar's sink while the bar is docked in the thread page, else null (the page keeps its own composer). */
export const getDockedBarSink = (): Sink | null => (sink?.docked ? sink.fn : null);

/**
 * Drag and drop for the bar's box. `dropping` is true while a file is over the bar, and, for a docked bar, while a file is dragged
 * anywhere over the window (the page takes the drop there), so the bar shows where it will land.
 */
export function useBarDrop(docked: boolean) {
	const [over, setOver] = useState(false);
	const [pageDrag, setPageDrag] = useState(false);
	useEffect(() => {
		if (!docked) return;
		const enter = (e: globalThis.DragEvent) => void (dragHasFiles(e.dataTransfer) && setPageDrag(true));
		const end = (e: globalThis.DragEvent) => void ((e.type !== "dragleave" || !e.relatedTarget) && setPageDrag(false));
		window.addEventListener("dragenter", enter);
		window.addEventListener("dragleave", end);
		window.addEventListener("drop", end);
		window.addEventListener("dragend", end);
		return () => {
			window.removeEventListener("dragenter", enter);
			window.removeEventListener("dragleave", end);
			window.removeEventListener("drop", end);
			window.removeEventListener("dragend", end);
			setPageDrag(false);
		};
	}, [docked]);
	const props = {
		onDragOver: (e: DragEvent) => {
			if (!sink || !dragHasFiles(e.dataTransfer)) return;
			e.preventDefault();
			setOver(true);
		},
		onDragLeave: (e: DragEvent) => {
			if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
		},
		onDrop: (e: DragEvent) => {
			setOver(false);
			setPageDrag(false);
			if (!sink || !dragHasFiles(e.dataTransfer)) return;
			e.preventDefault();
			sink.fn(droppedFiles(e.dataTransfer));
		},
	};
	return { dropping: over || pageDrag, props };
}

/** Registers the composer's file handler for the bar's drop target for as long as the composer is mounted. */
export function useRegisterBarDrop(fn: Sink, docked: boolean): void {
	useEffect(() => {
		registerBarDropSink(fn, docked);
		return () => registerBarDropSink(null);
	}, [fn, docked]);
}
