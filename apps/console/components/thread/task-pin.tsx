"use client";

import { GaugeIcon } from "lucide-react";
import { pin, unpin, useThreadPins } from "@/components/thread/pin-store";

/**
 * The bound task's pin (Pin {kind: "task", id: "task"}) carries the bound item's id in its `title`, so the chip always knows
 * which item it belongs to. The owner's x hides the chip for THAT item only: the hidden item id is remembered per thread, so
 * binding a different item shows it again, and the header toggle clears it. Hiding never changes the binding; unbinding
 * removes the pin and forgets the hidden item.
 */
const KEY = "wp.task-pin.hidden.v1";
let memory: Record<string, string> = {};

function read(): Record<string, string> {
	try {
		const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
		return v && typeof v === "object" && !Array.isArray(v) ? { ...memory, ...(v as Record<string, string>) } : memory;
	} catch {
		return memory;
	}
}

function write(next: Record<string, string>) {
	memory = next;
	try {
		localStorage.setItem(KEY, JSON.stringify(next));
	} catch {
		/* memory only */
	}
}

/** Keep the task pin in step with the thread's binding: pin it while bound (unless the owner hid it for this item), remove it when unbound. */
export function syncTaskPin(threadId: string, bound: string | undefined) {
	const { [threadId]: hidden, ...rest } = read();
	if (bound === undefined) {
		if (hidden !== undefined) write(rest);
		unpin(threadId, { kind: "task", id: "task" });
		return;
	}
	if (hidden === bound) return;
	if (hidden !== undefined) write(rest); // a different item is bound now: the old hiding is moot
	pin(threadId, { kind: "task", id: "task", title: bound, pinnedBy: "agent" });
}

/** The owner's x on the task chip: remove it and remember it as hidden for the item it was made for. */
export function hideTaskPin(threadId: string, boundItem: string | undefined) {
	if (boundItem !== undefined) write({ ...read(), [threadId]: boundItem });
	unpin(threadId, { kind: "task", id: "task" });
}

/** Header control: bring the chip back (clearing the hidden mark). */
export function showTaskPin(threadId: string, bound: string) {
	const { [threadId]: _drop, ...rest } = read();
	write(rest);
	pin(threadId, { kind: "task", id: "task", title: bound, pinnedBy: "agent" });
}

/** Small header button, rendered only while a task is bound and its chip is hidden. */
export function TaskPinToggle({ threadId, bound }: { threadId: string; bound: string | undefined }) {
	const pins = useThreadPins(threadId);
	if (bound === undefined || pins.some((p) => p.kind === "task")) return null;
	return (
		<button
			type="button"
			data-testid="task-pin-show"
			aria-label="Show the bound task"
			title="Show the bound task"
			onClick={() => showTaskPin(threadId, bound)}
			className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
		>
			<GaugeIcon className="size-4" />
		</button>
	);
}

/** Test hook: forget the in-memory copy. */
export function resetHiddenTasks() {
	memory = {};
}
