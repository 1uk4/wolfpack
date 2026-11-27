import { useEffect, useRef } from "react";

/**
 * Space bar dictation. Hold Space (300 ms or more) to dictate and release to stop and send; tap Space to toggle dictation
 * (no send). A hold while a run is already live stops it and sends on release. The send itself is the window event
 * `wolfpack:dictation-autosend`, dispatched after finish() resolves; the chat bar's composer consumes it.
 *
 * Space only belongs to us where it has no other job: the body, a non-interactive element, or an EMPTY composer textarea.
 * spaceKeyMachine and spaceKeyLive are pure; useSpaceDictation is the thin DOM wiring.
 */

export const DICTATION_AUTOSEND_EVENT = "wolfpack:dictation-autosend";
export const SPACE_HOLD_MS = 300;

export type SpaceAction = "none" | "start" | "toggle" | "finish-and-send";

export type SpaceEvent =
	| { type: "keydown"; at: number; repeat: boolean; running: boolean }
	| { type: "keyup"; at: number }
	| { type: "timer"; at: number };

export interface SpaceKeyMachine {
	send(e: SpaceEvent): SpaceAction;
}

/** Events in, one action out. keydown arms it; the timer (fired holdMs after keydown) makes it a hold; keyup resolves it. */
export function spaceKeyMachine({ holdMs = SPACE_HOLD_MS }: { holdMs?: number } = {}): SpaceKeyMachine {
	let downAt: number | null = null;
	let running = false;
	let held = false;
	return {
		send(e) {
			if (e.type === "keydown") {
				if (e.repeat || downAt !== null) return "none";
				downAt = e.at;
				running = e.running;
				held = false;
				return "none";
			}
			if (downAt === null) return "none";
			if (e.type === "timer") {
				if (held || e.at - downAt < holdMs) return "none";
				held = true;
				// Not running: the hold starts a run. Running: the hold only marks the release as stop-and-send.
				return running ? "none" : "start";
			}
			const wasHeld = held;
			downAt = null;
			held = false;
			return wasHeld ? "finish-and-send" : "toggle";
		},
	};
}

/** What the live check needs to know about the page, as plain data. */
export interface SpaceKeyInfo {
	repeat: boolean;
	composing: boolean;
	modifier: boolean;
	modalOpen: boolean;
	phone: boolean;
	/** The focused/target element. */
	target: { tag: string; type?: string; role?: string; editable: boolean; value?: string };
}

const INTERACTIVE_TAGS = new Set(["input", "select", "button", "a", "summary", "option"]);
const INTERACTIVE_ROLES = new Set(["button", "link", "checkbox", "switch", "radio", "menuitem", "tab", "option", "textbox", "combobox", "slider"]);

/** Whether a Space keydown belongs to dictation (and so gets preventDefault). */
export function spaceKeyLive(i: SpaceKeyInfo): boolean {
	if (i.repeat || i.composing || i.modifier || i.modalOpen || i.phone) return false;
	const t = i.target;
	if (t.editable) return false;
	if (t.tag === "textarea") return (t.value ?? "") === "";
	if (INTERACTIVE_TAGS.has(t.tag)) return false;
	if (t.role && INTERACTIVE_ROLES.has(t.role)) return false;
	return true;
}

function targetInfo(el: Element | null): SpaceKeyInfo["target"] {
	const h = el as HTMLElement | null;
	if (!h) return { tag: "body", editable: false };
	const ce = h.closest?.("[contenteditable]")?.getAttribute("contenteditable");
	return {
		tag: h.tagName.toLowerCase(),
		role: h.closest?.("[role]")?.getAttribute("role") ?? undefined,
		editable: ce !== undefined && ce !== null && ce !== "false",
		value: (h as HTMLTextAreaElement).value,
	};
}

function onPhone(): boolean {
	if (typeof window.matchMedia !== "function") return false;
	return window.matchMedia("(max-width: 767px)").matches || window.matchMedia("(pointer: coarse)").matches;
}

interface Controls {
	enabled: boolean;
	/** True when this hook is the one that answers the shortcut (as for ⌘D). */
	isTarget: () => boolean;
	running: () => boolean;
	toggle: () => void;
	finish: () => Promise<void>;
}

export function useSpaceDictation(c: Controls): void {
	const ref = useRef(c);
	ref.current = c;
	useEffect(() => {
		if (!c.enabled) return;
		const m = spaceKeyMachine({ holdMs: SPACE_HOLD_MS });
		let timer: ReturnType<typeof setTimeout> | undefined;
		let armed = false;
		const act = (a: SpaceAction) => {
			const k = ref.current;
			if (a === "toggle") k.toggle();
			else if (a === "start") {
				if (!k.running()) k.toggle();
			} else if (a === "finish-and-send") {
				void k.finish().then(() => window.dispatchEvent(new CustomEvent(DICTATION_AUTOSEND_EVENT)));
			}
		};
		const onDown = (e: KeyboardEvent) => {
			if (e.key !== " " && e.code !== "Space") return;
			if (armed) {
				// Our own key is held: swallow its auto-repeats.
				e.preventDefault();
				return;
			}
			const live = spaceKeyLive({
				repeat: e.repeat,
				composing: e.isComposing,
				modifier: e.metaKey || e.ctrlKey || e.altKey || e.shiftKey,
				modalOpen: !!document.querySelector('[aria-modal="true"]'),
				phone: onPhone(),
				target: targetInfo((e.target as Element | null) ?? document.activeElement),
			});
			if (!live || !ref.current.isTarget()) return;
			e.preventDefault();
			armed = true;
			m.send({ type: "keydown", at: Date.now(), repeat: false, running: ref.current.running() });
			timer = setTimeout(() => act(m.send({ type: "timer", at: Date.now() })), SPACE_HOLD_MS);
		};
		const onUp = (e: KeyboardEvent) => {
			if (!armed || (e.key !== " " && e.code !== "Space")) return;
			armed = false;
			clearTimeout(timer);
			e.preventDefault();
			act(m.send({ type: "keyup", at: Date.now() }));
		};
		window.addEventListener("keydown", onDown, true);
		window.addEventListener("keyup", onUp, true);
		return () => {
			clearTimeout(timer);
			window.removeEventListener("keydown", onDown, true);
			window.removeEventListener("keyup", onUp, true);
		};
	}, [c.enabled]);
}
