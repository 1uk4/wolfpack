"use client";

import { CornerDownLeftIcon, ImageIcon, PaperclipIcon, SquareIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { droppedFiles, pastedImages, PICKER_ACCEPT, type PendingAttachment } from "@/components/attachments";

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
	autoFocus,
	inputRef,
	onEscape,
	placeholder = "Ask, answer, or steer…",
	onFiles,
	onPickFiles,
	chips,
	enterSends,
}: {
	busy: boolean;
	value: string;
	onChange: (v: string) => void;
	onSend: () => void;
	onStop: () => void;
	canSend: boolean;
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
}) {
	const act = (viaEnter = false) => {
		const action = viaEnter && enterSends ? "send" : enterAction({ busy, canSend });
		if (action === "stop") onStop();
		else if (action === "send") onSend();
	};
	return (
		<>
		{chips}
			<form
				data-testid="composer"
				className="flex items-end gap-1.5 p-1.5"
				onSubmit={(e) => {
					e.preventDefault();
					act();
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
							onClick={(e) => (e.currentTarget.previousElementSibling as HTMLInputElement | null)?.click()}
							className="flex size-10 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
						>
							<PaperclipIcon className="size-4" />
						</button>
					</>
				)}
				<textarea
					ref={inputRef}
					value={value}
					onChange={(e) => onChange(e.target.value)}
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
					className="field-sizing-content lh-input max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground"
				/>
				{/* The button follows the text (owner report 2026-10-03): while
					 a turn runs WITH text typed it stays the SEND affordance
					 (click = steer — steering must be clickable, not Enter-only);
					 only an empty composer morphs it to Stop. ESC keeps its
					 confirm-popup abort in every state, so stop is never
					 unreachable. No tooltip — the ↵ glyph is the affordance
					 (owner, subtlety round 2026-09-25). */}
				<button
					type="submit"
					aria-label={busy && !canSend ? "Stop" : "Send"}
					disabled={!busy && !canSend}
					className={cn(
						"flex size-10 shrink-0 items-center justify-center rounded-[10px] transition-colors",
						busy && !canSend
							? "bg-secondary text-foreground hover:bg-accent"
							: "bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40",
					)}
				>
					{busy && !canSend ? <SquareIcon className="size-4" /> : <CornerDownLeftIcon className="size-5" />}
				</button>
			</form>
		</>
	);
}
