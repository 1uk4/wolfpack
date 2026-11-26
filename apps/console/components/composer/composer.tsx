"use client";

import { ArrowUpIcon, CornerDownLeftIcon, ImageIcon, KeyboardIcon, Loader2Icon, MicIcon, PaperclipIcon, SquareIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { endOnFocus, endOnOutsideMouseDown } from "@/components/composer/caret-end";
import { Hint } from "@/components/ui/hint";
import { RecordingMarker } from "@/components/composer/recording-marker";
import { droppedFiles, pastedImages, PICKER_ACCEPT, type PendingAttachment } from "@/components/composer/attachments";

/** What the main button is. The whole dictation span is inert for the wolf's turn: while the run records it is Stop dictation
 *  (ends the run, the text stays); while its last words flush it is a disabled spinner. Otherwise Stop (square) only for a busy
 *  turn with nothing to send; else Send. */
function mainButtonMode(state: { dictating: boolean; finishing: boolean; busy: boolean; canSend: boolean; voice?: boolean }): "stop-dictation" | "finishing" | "stop-wolf" | "send" | "dictate" {
	if (state.finishing) return "finishing";
	if (state.dictating) return "stop-dictation";
	// The phone's voice-first composer: with nothing to send the big button is the mic, even while the wolf works (a separate small Stop sits beside it).
	if (state.voice && !state.canSend) return "dictate";
	if (state.busy && !state.canSend) return "stop-wolf";
	return "send";
}

/**
 * The phone dock's voice-first layout (chat-bar only): a large mic in the middle with add-image and a keyboard toggle beside it.
 * `field` says what stands where the text field is: the compact tap-to-type field (voice), the real textarea (text) or the live transcript (transcript).
 */
export type VoiceLayout = {
	field: "voice" | "text" | "transcript";
	onDictate: () => void;
	/** Switch the field to the text input (the keyboard icon and the compact field). */
	onOpenField: () => void;
	/** The finals heard so far in the live run. */
	transcript: string;
	/** The text already in the field when the run started: shown dimmed and read-only above the transcript. */
	draft: string;
	/** The level meter shown beside the transcript. */
	meter: React.ReactNode;
	error?: string | null;
};

/**
 * The chat composer — content row ONLY (the persistent rounded shell lives in
 * the chat view's overlay, so the shell can later morph chat → question
 * without remounting).
 *
 * Corner-radius math (concentric with the shell): shell rounded-2xl (16px) −
 * row padding p-1.5 (6px) = button rounded-[10px] = 25% of the 40px button.
 */

/** What one Enter press does, in precedence order: stop a busy stream,
 *  otherwise send the message. Pure so the static-render harness can pin
 *  the decision (key events can't be simulated in renderToStaticMarkup). */
export function enterAction(state: { busy: boolean; canSend: boolean }): "stop" | "send" | "none" {
	// Composer steering (owner arc 2026-10-03): while a turn runs, typed
	// text makes Enter a STEER (the queue-and-redirect send); Enter with
	// an empty composer stays the stop shortcut. The button itself keeps
	// the square — Stop stays one click away at all times.
	if (state.busy) return state.canSend ? "send" : "stop";
	if (state.canSend) return "send";
	return "none";
}

/** The pending-attachment chips above the composer row. */
export function AttachmentChips({ items, onRemove }: { items: readonly PendingAttachment[]; onRemove: (key: string) => void }) {
	if (items.length === 0) return null;
	return (
		<div data-testid="attachment-chips" className="flex flex-wrap gap-1.5 px-2 pt-2">
			{items.map((a) => (
				<span
					key={a.key}
					data-testid="attachment-chip"
					data-status={a.status}
					title={a.error}
					className={cn(
						"flex items-center gap-1 rounded-md border bg-secondary px-1.5 py-0.5 font-ui text-xs",
						a.status === "error" ? "max-w-96 border-destructive/50 text-destructive" : "max-w-48",
						a.status === "uploading" && "opacity-60",
					)}
				>
					<ImageIcon className="size-3 shrink-0" />
					<span className={a.status === "error" ? "break-words" : "truncate"}>{a.status === "error" ? `${a.name} — ${a.error ?? "failed"}` : a.status === "uploading" ? `${a.name}…` : a.name}</span>
					<button type="button" aria-label={`Remove ${a.name}`} onClick={() => onRemove(a.key)} className="shrink-0 hover:text-foreground">
						<XIcon className="size-3" />
					</button>
				</span>
			))}
		</div>
	);
}

export function Composer({
	busy,
	value,
	onChange,
	onSend,
	onStop,
	canSend,
	finishing,
	dictating,
	recording,
	autoFocus,
	inputRef,
	onEscape,
	placeholder = "Ask, answer, or steer…",
	onFiles,
	onPickFiles,
	chips,
	enterSends,
	controls,
	sendLabel,
	alwaysLabel,
	attachDisabled,
	armed,
	sendAriaLabel,
	voice,
}: {
	/** Phone dock only: the voice-first layout. Absent: the classic composer row. */
	voice?: VoiceLayout;
	/** The questionnaire's "Send anyway?" state: the button widens and changes colour, a cancel × appears beside it and Esc cancels. */
	armed?: { onCancel: () => void };
	/** Accessible name of the send button when it differs from its visible label. */
	sendAriaLabel?: string;
	/** Keep the send label even with nothing to send (the questionnaire's Next / Submit, shown disabled). */
	alwaysLabel?: boolean;
	/** Replaces the send button's icon with this text while there is something to send (the bar's "Reply instead" with a card open). An empty composer keeps Send / Stop. */
	sendLabel?: string;
	/** Why attaching is off right now (the attach button is shown disabled with this as its title). */
	attachDisabled?: string;
	busy: boolean;
	value: string;
	onChange: (v: string) => void;
	onSend: () => void;
	onStop: () => void;
	canSend: boolean;
	/** A dictation run is flushing its last words (the mic is already off): the send button shows a spinner meanwhile. */
	finishing?: boolean;
	/** A dictation run is recording: the main button becomes Stop dictation (mic). onSend must then only finish the run. */
	dictating?: boolean;
	/** This field is where the live dictation lands: a marker sits at its inner right edge (spinner while the run stops). */
	recording?: "live" | "stopping";
	autoFocus?: boolean;
	/** The page's handle to the textarea — the dictation-end focus (owner,
	 *  2026-10-01): a run ending hands the cursor to the bare composer. */
	inputRef?: React.RefObject<HTMLTextAreaElement | null>;
	/** Escape while a dictation runs stops it (STT wave, 2026-09-17). No-op
	 *  when absent — Esc otherwise means nothing in the composer. */
	onEscape?: () => void;
	/** The textarea's placeholder (owner refinement round, 2026-09-24):
	 *  active sessions read "Ask, answer, or steer…". */
	placeholder?: string;
	/** Images pasted into the textarea (the paste is swallowed only when it held images). */
	onFiles?: (files: File[]) => void;
	/** Files chosen with the picker button (absent: no button). */
	onPickFiles?: (files: File[]) => void;
	/** Pending attachment chips, rendered above the row. */
	chips?: React.ReactNode;
	/** Keyboard Enter sends even when the button state says Stop (a live dictation while a turn runs: Enter
	 *  finishes it and steers the spoken text; the button stays Stop). Absent: Enter follows the button. */
	enterSends?: boolean;
	/** Per-thread controls (model tier, auto-ship), shown beside the send button. */
	controls?: React.ReactNode;
}) {
	const mode = mainButtonMode({ dictating: dictating === true, finishing: finishing === true, busy, canSend, voice: voice !== undefined });
	const labelled = (mode === "send" || mode === "stop-wolf") && sendLabel !== undefined && (canSend || alwaysLabel === true);
	const act = (viaEnter = false) => {
		// Dictation phases never reach onStop: recording only finishes the run, flushing does nothing.
		if (mode === "finishing") return;
		if (mode === "stop-dictation") return onSend();
		// Enter in the open field never starts the mic: with the wolf working it stays the stop shortcut.
		if (mode === "dictate") return viaEnter ? (busy ? onStop() : undefined) : voice?.onDictate();
		const action = viaEnter && enterSends ? "send" : enterAction({ busy, canSend });
		if (action === "stop") onStop();
		else if (action === "send") onSend();
	};
	const buttonLabel =
		mode === "finishing" ? "Finishing dictation" : mode === "stop-dictation" ? "Stop dictation" : mode === "dictate" ? "Start dictation" : labelled ? (sendAriaLabel ?? sendLabel ?? "Send") : mode === "stop-wolf" ? "Stop" : "Send";
	const mainButton = (
		<button
			type="submit"
			data-testid={voice ? "voice-main" : undefined}
			data-armed={armed ? "true" : undefined}
			data-finishing={finishing ? "true" : undefined}
			data-dictating={mode === "stop-dictation" ? "true" : undefined}
			aria-label={buttonLabel}
			disabled={mode === "finishing" || (mode === "send" && !canSend)}
			className={cn(
				"flex size-10 shrink-0 items-center justify-center rounded-[10px] transition-colors max-md:size-11 max-md:rounded-full",
				voice && "max-md:size-14",
				mode === "dictate" && "bg-(color:--thread-accent) text-(color:--thread-accent-foreground) hover:opacity-90",
				labelled && "wp-send-label w-auto px-3 font-ui text-xs",
				// Dictation modes win over the armed ("Send anyway?") look: while the mic is live the button must read as the mic.
				mode === "finishing"
					? "bg-(color:--thread-accent) text-(color:--thread-accent-foreground) opacity-70"
					: mode === "stop-dictation"
					? "bg-(color:--thread-accent) text-(color:--thread-accent-foreground) hover:opacity-90"
					: armed
					? "wp-send-armed bg-foreground text-background hover:opacity-90"
					: mode === "stop-wolf"
					? "bg-secondary text-foreground hover:bg-accent max-md:bg-(color:--thread-accent) max-md:text-(color:--thread-accent-foreground)"
					: "bg-(color:--thread-accent) text-(color:--thread-accent-foreground) hover:opacity-90 disabled:opacity-40",
			)}
		>
			{mode === "finishing" ? (
				<Loader2Icon className="size-5 animate-spin" />
			) : mode === "stop-dictation" ? (
				// Live indicator: a soft pulse while the mic records (off under prefers-reduced-motion).
				<MicIcon className={cn("size-5 motion-safe:animate-pulse", voice && "size-6")} />
			) : mode === "dictate" ? (
				<MicIcon className="size-6" />
			) : labelled ? (
				<span key={sendLabel} className="wp-swap-in whitespace-nowrap">{sendLabel}</span>
			) : mode === "stop-wolf" ? (
				<SquareIcon className="size-4 max-md:fill-current" />
			) : (
				<>
					<CornerDownLeftIcon className="size-5 max-md:hidden" />
					<ArrowUpIcon className="size-5 md:hidden" />
				</>
			)}
		</button>
	);
	return (
		<>
		{chips}
			<form
				data-testid="composer"
				data-field={voice?.field}
				className={cn("flex items-end gap-1.5 p-1.5 max-md:flex-wrap", voice && "items-center justify-center gap-x-5")}
				onSubmit={(e) => {
					e.preventDefault();
					act();
				}}
				onKeyDown={(e) => {
					// Esc while the voice dock's transcript shows (focus anywhere in the form) cancels the run, like Esc in the field.
					if (e.key === "Escape" && voice?.field === "transcript" && onEscape) {
						e.preventDefault();
						e.stopPropagation();
						onEscape();
						return;
					}
					// Esc while armed (focus on the button or the textarea) leaves the asking state.
					if (e.key === "Escape" && armed) {
						e.preventDefault();
						e.stopPropagation();
						armed.onCancel();
					}
				}}
			>
				{onPickFiles && (
					<>
						<input
							type="file"
							multiple
							accept={PICKER_ACCEPT}
							data-testid="attachment-picker"
							className="hidden"
							tabIndex={-1}
							onChange={(e) => {
								const files = droppedFiles(e.target);
								e.target.value = ""; // the same file can be picked again
								if (files.length > 0) onPickFiles(files);
							}}
						/>
						<button
							type="button"
							aria-label="Attach images"
							disabled={attachDisabled !== undefined}
							title={attachDisabled}
							onClick={(e) => (e.currentTarget.previousElementSibling as HTMLInputElement | null)?.click()}
							className={cn("flex size-10 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground max-md:size-11 transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent", voice && "max-md:rounded-full")}
						>
							<PaperclipIcon className="size-4" />
						</button>
					</>
				)}
				{voice?.field === "voice" && (
					<button type="button" data-testid="voice-field" onClick={voice.onOpenField} className="order-first flex min-h-11 w-full basis-full items-center truncate rounded-xl border bg-secondary/50 px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-secondary">
						<span className="truncate">{voice.error ?? "Tap to type, or talk"}</span>
					</button>
				)}
				{voice?.field === "transcript" && (
					<div className="order-first flex w-full basis-full flex-col gap-1.5 rounded-xl border bg-secondary/50 px-3 py-2">
						{voice.draft !== "" && <div data-testid="dictation-draft" aria-readonly="true" className="max-h-16 overflow-y-auto whitespace-pre-wrap text-sm text-muted-foreground/60">{voice.draft}</div>}
						{/* Esc is caught on the form (focus stays on the mic button), so the log needs no tab stop. */}
						<div data-testid="dictation-transcript" role="log" aria-atomic="false" className="max-h-32 min-h-8 overflow-y-auto text-sm">
							{voice.transcript}
						</div>
						{voice.meter}
					</div>
				)}
				<div className={cn("relative flex min-w-0 flex-1 max-md:order-first max-md:basis-full", voice && voice.field !== "text" && "hidden")}>
				<textarea
					ref={inputRef}
					value={value}
					onChange={(e) => onChange(e.target.value)}
					onMouseDown={endOnOutsideMouseDown}
					onFocus={endOnFocus}
					onPaste={(e) => {
						if (!onFiles) return;
						const files = pastedImages(e.clipboardData);
						if (files.length === 0) return;
						e.preventDefault();
						onFiles(files);
					}}
					onKeyDown={(e) => {
						// Esc ends dictation before anything else Esc might someday mean
						// here (the dictate decisions: click-again or Esc to stop).
						// stopPropagation claims the Esc (keyboard wave A): the
						// window-level chain must not also abort a turn under us.
						if (e.key === "Escape" && onEscape) {
							e.preventDefault();
							e.stopPropagation();
							onEscape();
							return;
						}
						// Chat convention: Enter sends, Shift+Enter is a newline.
						// ⌘/Ctrl+Enter also sends — the universal submit shortcut
						// across every input in the app (thinking field, answers).
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
							e.preventDefault();
							act(true);
						}
					}}
					placeholder={placeholder}
					autoFocus={autoFocus}
					rows={1}
					className={cn("field-sizing-content wp-input max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground", recording && "pr-7")}
				/>
				{recording && <RecordingMarker state={recording} className="absolute right-1.5 top-3" />}
				</div>
				{controls}
				{/* The button follows the text (owner report 2026-10-03): while
					 a turn runs WITH text typed it stays the SEND affordance
					 (click = steer — steering must be clickable, not Enter-only);
					 only an empty composer morphs it to Stop. ESC keeps its
					 confirm-popup abort in every state, so stop is never
					 unreachable. */}
				{armed && (
					<button type="button" data-testid="ask-keep-answering" aria-label="Keep answering" title="Keep answering" onClick={armed.onCancel} className="wp-swap-in flex size-8 shrink-0 items-center justify-center self-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground max-md:size-11">
						<XIcon className="size-4" />
					</button>
				)}
				{/* Always wrapped so a mode switch keeps the button mounted (focus stays). */}
				<Hint label={buttonLabel}>{mainButton}</Hint>
				{voice && busy && mode === "dictate" && (
					<Hint label="Stop the wolf">
						<button type="button" data-testid="voice-stop" aria-label="Stop the wolf" onClick={onStop} className="flex size-11 shrink-0 items-center justify-center rounded-full bg-secondary text-foreground transition-colors hover:bg-accent">
							<SquareIcon className="size-4 fill-current" />
						</button>
					</Hint>
				)}
				{voice && (
					<Hint label="Type a message">
						<button type="button" data-testid="voice-keyboard" aria-label="Type a message" onClick={voice.onOpenField} disabled={voice.field !== "voice"} className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:invisible">
							<KeyboardIcon className="size-5" />
						</button>
					</Hint>
				)}
			</form>
		</>
	);
}
