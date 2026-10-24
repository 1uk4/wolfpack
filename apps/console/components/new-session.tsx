"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Conversation, ConversationContent, ConversationEmptyState } from "@/components/ai-elements/conversation";
import { Composer } from "@/components/composer";
import { DictationBar, joinDictation, useDictation } from "@/components/dictation";
import { useFieldCycle } from "@/components/field-cycle";
import { SidebarToggle } from "@/components/sidebar";
import { SetupDialog } from "@/components/setup-dialog";
import { useStrongKeyless, useZeroKeys, ZeroKeysPill } from "@/components/setup-cta";
import { StatsBar } from "@/components/stats-bar";
import { ComposerActions } from "@/components/composer-actions";

/**
 * The sessionless draft view at /chat/new (owner, 2026-09-13): "+ New
 * session" opens THIS, never a created record — a session comes to exist
 * only when the learner sends the first message, and that message becomes
 * the session's title (the exact create-then-redirect contract the home
 * composer established). Visually identical to a fresh chat: same header
 * (title + probe chip), the same empty state, the same composer blob +
 * stats dock. The draft's model control binds the strong slot (the
 * new-session default); the created session is stamped from it
 * server-side (per-session models, owner 2026-09-28).
 */

const DOCK = "mx-auto w-full max-w-[46rem] px-4";

/**
 * The draft's whole behavior as one pure seam: create the session (title =
 * the first message), persist the lifted pre-chat settings, return the push
 * target — /chat/<id>?prompt=<msg> — whose initialPrompt path delivers the
 * message as turn 1. Injected fetch/router so tests pin the contract.
 * Returns null on empty text; rethrows on transport failure (the caller's
 * busy flag resets).
 */
export async function startDraftSession(text: string, fetchLike: typeof fetch): Promise<string | null> {
	const t = text.trim();
	if (!t) return null;
	const res = await fetchLike("/api/chats", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title: t }),
	});
	const { id } = (await res.json()) as { id: string };
	// No settings PUT on create (per-session models, owner 2026-09-28):
	// the SERVER stamps the newborn from the strong slot.
	return `/chat/${id}?prompt=${encodeURIComponent(t)}`;
}

/** The pure shell (no router) — the render-test seam: the draft view's
 *  visible surface, assembled from the same pieces a fresh chat shows. */
/* FINISH-FIRST SEND + RUN-END FOCUS live in the shell (it owns the
 * dictation instance); the truth of the text stays in the parent, whose
 * send reads a REF mirror — see NewSession below. */
export function DraftShell({
	busy,
	text,
	onChange,
	onSend,
	setupCta,
}: {
	busy: boolean;
	text: string;
	onChange: (v: string) => void;
	onSend: () => void;
	/** The first-run CTA (fix wave chunk B): the same "Set up your models"
	 *  affordance home carries, rendered above the draft shell — passed by
	 *  NewSession, which owns the configured state and the SetupDialog. */
	setupCta?: ReactNode;
}) {
	// Voice dictation (STT wave, 2026-09-17): finals append at the end of the
	// draft text (via the parent's onChange — the truth lives there); the
	// strip lives in the stats bar's middle slot.
	// Tab navigates INTO the composer (owner, keyboard round 2026-10-06):
	// the only text field on this surface — the cycle's whole chain.
	const cycleComposer = useCallback((): readonly HTMLElement[] =>
		Array.from(document.querySelectorAll<HTMLElement>('[data-testid="composer"] textarea')),
		[]);
	useFieldCycle(cycleComposer);
	const dictation = useDictation({
		append: (t) => onChange(joinDictation(text, t)),
	});
	// A LIVE dictation keeps the composer sendable ("nothing gets lost"
	// round, owner 2026-10-01): the spoken text is deferred in the run's
	// buffer — Enter must reach the finish-first send, not be gated out by
	// an empty textarea. Nothing said → the send no-ops.
	const canSend = text.trim().length > 0 || dictation.active;
	/* FINISH DICTATION FIRST (owner, 2026-10-01): stop the run, let the
	 * last finals land through onChange, THEN call the parent's send —
	 * which reads its REF mirror, so the post-await timing of React's
	 * re-render cannot eat the dictated tail. */
	const handleSend = () => {
		if (dictation.active) {
			void dictation.finish().then(onSend);
			return;
		}
		onSend();
	};
	/* Run end focuses the composer (owner, 2026-10-01): the hands are on
	 * the keyboard from the stop — falling edge of `active` only. */
	const composerInputRef = useRef<HTMLTextAreaElement>(null);
	const dictationWasActiveRef = useRef(false);
	useEffect(() => {
		if (dictation.active) {
			dictationWasActiveRef.current = true;
		} else if (dictationWasActiveRef.current) {
			dictationWasActiveRef.current = false;
			composerInputRef.current?.focus();
		}
	}, [dictation.active]);
	return (
		/* CHROME-LESS CREATION SURFACE (owner round 11, 2026-10-05): the
		 * drafts join home's register — no TopBar, no title (the serif title
		 * always names a session; a draft has none). Home's proven pattern
		 * verbatim: a drag mask first in the DOM, a floating reopen toggle
		 * (the only pointer-events-auto spot), the empty state carrying the
		 * orientation. The chain picker then owns the column top exactly
		 * like the graph view's — no stacked bars. */
		<div className="relative flex h-dvh">
			{/* Window-drag strip — deliberately FIRST in the DOM (the mask
			    law: no-drag subtraction resolves by DOM order, so every
			    carved control later in the tree subtracts correctly). */}
			<div className="lh-drag absolute inset-x-0 top-0 h-13" aria-hidden="true" />
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="relative flex min-h-0 flex-1">
					{/* The pointer-events pattern (953b22b): the sticky wrapper is
					    pointer-events-none so nothing here blocks the empty-state
					    area; the blob and the stats row re-enable it themselves. */}
					<div className="pointer-events-none sticky bottom-0 mt-auto w-full">
						<Conversation className="h-full min-w-0 flex-1" initial="instant">
							<ConversationContent className="min-h-full gap-0 p-0">
								<ConversationEmptyState
									title="New session"
									description="Ask anything to get started."
								/>
							</ConversationContent>
						</Conversation>
						<div className="h-24 bg-gradient-to-t from-background via-background/85 to-transparent" />
						<div className="bg-background pb-4">
							<div className={DOCK}>
								<ComposerActions setup={setupCta} />
								<div className="pointer-events-auto overflow-hidden rounded-2xl border bg-card shadow-lg">
									<Composer
										busy={busy}
										value={text}
										onChange={onChange}
										onSend={handleSend}
										onStop={() => {}}
										canSend={canSend}
										inputRef={composerInputRef}
										autoFocus
										onEscape={dictation.active ? dictation.cancel : undefined}
										// The opening prompt — no conversation has started yet, so
										// the composer must not read like one is in flight.
										placeholder="What's on your mind?"
									/>
								</div>
								<StatsBar
									dictationSlot={<DictationBar dictation={dictation} />}
									turns={[]}
								/>
							</div>
						</div>
					</div>
				</div>
			</div>
			{/* The floating reopen toggle — pointer-events-none except the
			    toggle itself (home's pattern), painted AFTER the overlay's
			    column so nothing of it blocks the canvas area. */}
			<header className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 px-3 py-2">
				<div className="pointer-events-auto">
					<SidebarToggle />
				</div>
			</header>
		</div>
	);
}

export function NewSession({ initialConfigured }: { initialConfigured: boolean }) {
	const router = useRouter();
	const [text, setText] = useState("");
	/* The draft MIRROR ("nothing gets lost" round, 2026-10-01): the shell's
	 * finish-first send calls THIS send after the dictation flush — which
	 * landed via setState and may not have re-rendered yet. The send reads
	 * the mirror; every write keeps it current. */
	const textRef = useRef("");
	const applyText = (v: string) => {
		textRef.current = v;
		setText(v);
	};
	const [busy, setBusy] = useState(false);
	// First-run gate (model-slots wave, owner 2026-09-20): the send
	// INTERCEPTS into the setup flow while unconfigured — no defaults for
	// 33 providers, chats cannot start. The draft stays in the textarea;
	// Save stores the slots and never sends (owner ruling 2026-10-09) —
	// the learner sends the draft themselves.
	const [configured, setConfigured] = useState(initialConfigured);
	// The zero-keys truth (zero-keys wave): no provider key = the pill
	// takes precedence over the models CTA (keys come first in the chain).
	const zeroKeys = useZeroKeys();
	// The strong slot's keyless truth (pre-send key guards, owner interlude
	// 2026-09-25): keys may exist generally while the STRONG slot's pinned
	// provider has none — the same skip-everything treatment on send.
	const strongKeyless = useStrongKeyless();
	const [setupOpen, setSetupOpen] = useState(false);

	const send = useCallback(() => {
		const draft = textRef.current.trim();
		if (!draft || busy) return;
		if (!configured) {
			setSetupOpen(true);
			return;
		}
		// The pre-send KEY guards (owner interlude, no-orphan-chats): guard
		// BEFORE startDraftSession creates the record — a refused first
		// send would otherwise leave an orphan error-shell chat in the
		// sidebar. Same skip-everything-and-open-setup treatment; the
		// server's 503 gate remains the belt for /chat/[id] sessions.
		if (zeroKeys || strongKeyless) {
			setSetupOpen(true);
			return;
		}
		setBusy(true);
		void startDraftSession(draft, fetch)
			.then((target) => {
				if (target) router.push(target);
				else setBusy(false);
			})
			.catch(() => setBusy(false));
	}, [busy, router, configured, zeroKeys, strongKeyless]);

	return (
		<>
			<DraftShell
				busy={busy}
				text={text}
				onChange={applyText}
				onSend={send}
				setupCta={
					zeroKeys ? (
						<ZeroKeysPill inline onOpen={() => setSetupOpen(true)} />
					) : (
						!configured && (
							<button
								type="button"
								data-testid="setup-cta"
								onClick={() => setSetupOpen(true)}
								className="rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent cursor-pointer"
							>
								Set up your models
							</button>
						)
					)
				}
			/>
			{/* First-run setup: the send interception's landing surface — stage
			    1 is the self-contained first-key screen (zero-keys wave). */}
			<SetupDialog
				open={setupOpen}
				onClose={() => setSetupOpen(false)}
				onDone={() => {
					setConfigured(true);
					setSetupOpen(false);
					// Save only saves (owner ruling 2026-10-09): the draft
					// waits in the composer; the learner sends it.
				}}
				/>
		</>
	);
}