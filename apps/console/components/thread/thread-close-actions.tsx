"use client";

/**
 * Close, reopen and remove a feature thread (work item untouched). One set of pieces shared by the sidebar row menu,
 * the thread header menu and the closed-thread banner:
 *   - `threadCloseApi`: the three console routes;
 *   - `ThreadActionsMenu`: a ⋯ button with the actions that fit the thread's state (Close; or Reopen + Remove…);
 *   - `RemoveThreadDialog`: the confirmation ("Remove this thread?").
 */
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/shell/backdrop-dismiss";

/** The reason text the wolf gives a thread the owner closed (wolfd CLOSED_BY_OWNER); anything else is a graduation. */
export const CLOSED_BY_OWNER = "Closed by you";

export interface ThreadRef {
	wolf: string;
	slug: string;
}

const base = (r: ThreadRef) => `/api/wolves/${encodeURIComponent(r.wolf)}/threads/${encodeURIComponent(r.slug)}`;

async function call(url: string, method: "POST" | "DELETE"): Promise<void> {
	const res = await fetch(url, { method });
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `request failed (${res.status})`);
	}
}

export const threadCloseApi = {
	close: (r: ThreadRef) => call(`${base(r)}/close`, "POST"),
	reopen: (r: ThreadRef) => call(`${base(r)}/reopen`, "POST"),
	remove: (r: ThreadRef) => call(base(r), "DELETE"),
};

/** The thread slug of a row href (`/wolf/<name>/thread/<slug>`), or undefined. */
export const slugOfHref = (href: string | undefined): string | undefined => {
	const m = /\/thread\/([^/?#]+)/.exec(href ?? "");
	return m ? decodeURIComponent(m[1]!) : undefined;
};

/** Whether a closed reason is the owner's own close (so Reopen is allowed); a graduation hides Reopen. */
export const closedByOwner = (reason: string | undefined): boolean => reason === CLOSED_BY_OWNER;

export function RemoveThreadDialog({ wolf, workTitle, onCancel, onConfirm }: { wolf: string; workTitle: string; onCancel: () => void; onConfirm: () => Promise<void> }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const dismiss = useBackdropDismiss(onCancel);
	if (typeof document === "undefined") return null;
	return createPortal(
		<div {...dismiss} data-testid="remove-thread-dialog" role="dialog" aria-modal="true" aria-label="Remove this thread?" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
			<div className="w-full max-w-sm rounded-xl border bg-card p-5 shadow-xl">
				<h2 className="text-base font-medium">Remove this thread?</h2>
				<p className="mt-2 text-sm text-muted-foreground">
					The thread is removed from {wolf} and disappears from the list. The work item {workTitle} is not changed.
				</p>
				{error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
				<div className="mt-4 flex justify-end gap-2">
					<button type="button" data-testid="remove-thread-cancel" onClick={onCancel} className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground max-md:min-h-11">
						Cancel
					</button>
					<button
						type="button"
						data-testid="remove-thread-confirm"
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							try {
								await onConfirm();
							} catch (e) {
								setError(e instanceof Error ? e.message : String(e));
								setBusy(false);
							}
						}}
						className="rounded-md border border-destructive/60 bg-destructive/10 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/20 disabled:opacity-40 max-md:min-h-11"
					>
						Remove
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}

/**
 * The ⋯ menu of a feature thread. Open thread: Close. Closed thread: Reopen (not when graduated) and Remove….
 * `onRemove` opens the confirmation (the caller owns the dialog); errors surface as an alert line.
 */
export function ThreadActionsMenu({
	closed,
	canReopen,
	onClose,
	onReopen,
	onRemove,
	className = "",
	testid = "thread-actions",
}: {
	closed: boolean;
	canReopen: boolean;
	onClose: () => Promise<void> | void;
	onReopen: () => Promise<void> | void;
	onRemove: () => void;
	className?: string;
	testid?: string;
}) {
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string>();
	const run = (fn: () => Promise<void> | void) => async () => {
		setOpen(false);
		try {
			await fn();
			setError(undefined);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};
	const item = (id: string, label: ReactNode, onClick: () => void) => (
		<button type="button" role="menuitem" data-testid={`${testid}-${id}`} onClick={onClick} className="block w-full rounded-sm px-3 py-2 text-left text-sm hover:bg-accent max-md:min-h-11">
			{label}
		</button>
	);
	return (
		<span className={`relative inline-flex ${className}`} onClick={(e) => e.stopPropagation()}>
			<button
				type="button"
				data-testid={`${testid}-button`}
				aria-label="Thread actions"
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground max-md:size-11"
			>
				⋯
			</button>
			{open && (
				<div role="menu" data-testid={`${testid}-menu`} className="absolute right-0 top-full z-40 mt-1 min-w-36 rounded-md border bg-card p-1 shadow-lg">
					{!closed && item("close", "Close thread", run(onClose))}
					{closed && canReopen && item("reopen", "Reopen", run(onReopen))}
					{closed && item("remove", "Remove…", () => { setOpen(false); onRemove(); })}
				</div>
			)}
			{error && <span role="alert" data-testid={`${testid}-error`} className="absolute right-0 top-full z-40 mt-1 w-56 rounded-md border bg-card p-2 text-xs text-destructive">{error}</span>}
		</span>
	);
}
