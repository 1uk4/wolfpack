"use client";
/**
 * The Agent section: the compaction threshold and the prompt override switches. The model slots are gone: per-wolf models are
 * edited on the wolf Settings page (/settings).
 *
 * Prompts: GET /api/settings/prompts segments — the assistant's one
 * section (sectionedSegments). The row rulings: only the TOGGLE grays
 * when there's no override file (the file name is always full-contrast);
 * NO description line when there's no override (the empty state is
 * clean — toggle + name); the indicator ("Your version is saved") appears
 * ONLY when an override exists. The switch requires an override FILE
 * (route-enforced), so a file-less toggle is disabled. The segments view
 * re-reads on the 'wolfpack:settings-saved' signal for the agent section — the
 * view's enabled flags derive from the record's switches.
 */

import { useCallback, useEffect, useState } from "react";
import { MenuShell } from "@/components/menu-shell";
import { InlineMic, joinDictation, useFieldMic } from "@/components/dictation";
import { useSettingsSaved } from "@/components/settings-signal";
import type React from "react";
import {
	COMPACTION_THRESHOLD_FLOOR,
	resolveSettings,
	type AgentSettings,
	type CompactionSettings,
} from "@/src/core";
import { SettingsGroup, SettingsRow, Toggle, CommitInput } from "./controls.tsx";

/** SegmentInfo as GET /api/settings/prompts returns it. */
interface SegmentInfo {
	path: string;
	sourceText: string;
	overrideText: string | null;
	enabled: boolean;
	shared: boolean;
}

/** The indicator under a row whose override IS the version in use (owner
 *  ruling, refined 2026-09-26: the small text states WHICH VERSION IS
 *  IN USE — "Your version is in use" when the switch is on, and NOTHING
 *  when the default composes, even if a saved override sits on disk
 *  unused. The switch's meaning becomes legible: it visibly controls
 *  this line). Exported for the pin. */
export const PROMPT_IN_USE_HINT = "Your version is in use";

/** One section of the prompt view. */
export interface PromptSection {
	id: "assistant";
	label: string;
	segments: SegmentInfo[];
}

/** The server's segment view as one section. Pure — exported for tests. */
export function sectionedSegments(view: { assistant: SegmentInfo[] }): PromptSection[] {
	return [{ id: "assistant", label: "Assistant", segments: view.assistant }];
}

/** Compose: one prompt switch. on = explicit true; off = key REMOVED
 *  (absent = off is the schema's resting state; explicit false is the
 *  same thing but noisier). Pure — tests. */
export function composePromptSwitch(agent: AgentSettings | undefined, path: string, on: boolean): AgentSettings {
	const prompts = { ...agent?.prompts };
	if (on) prompts[path] = true;
	else delete prompts[path];
	return { ...agent, prompts };
}

/** The collapsed select look (owner: "the look of the collapsed menu is
 *  good") — now a button that opens the shared model-picker dropdown. */
function MenuTrigger({
	value,
	emptyLabel,
	ariaLabel,
	testid,
	open,
	onClick,
	widthClass,
	disabled,
}: {
	value: string;
	/** What the trigger shows when there is no override ("Default"). */
	emptyLabel: string;
	ariaLabel: string;
	testid: string;
	open: boolean;
	onClick: () => void;
	/** Owner (2026-09-20): the thinking trigger is FIXED at the width the
	 *  Default state needs (values shifting it mid-edit shifted the row);
	 *  the model trigger takes the same width as a MINIMUM — its values
	 *  genuinely vary in length. */
	widthClass: string;
	/** The no-key search state grays the whole row; the trigger follows. */
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			aria-label={ariaLabel}
			aria-expanded={open}
			data-testid={testid}
			onClick={() => {
				if (!disabled) onClick();
			}}
			className={`flex h-7 items-center gap-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground transition-colors ${
				disabled ? "cursor-not-allowed" : "hover:border-muted-foreground/50"
			} ${widthClass}`}
		>
			<span className="min-w-0 flex-1 truncate">{value || emptyLabel}</span>
			<span aria-hidden className="text-muted-foreground">
				▾
			</span>
		</button>
	);
}

/* The section's dropdowns all mount the shared MenuShell (fix wave chunk
 * B): portaled to document.body, fixed-anchored to the open trigger by
 * testid (the section's one-ref pattern), opening DOWN with the shell's
 * viewport cap and auto-flip. data-wp-menu rides the shell — the
 * outside-click contract's exemption mark. */

export function AgentSection({
	agent,
	compaction,
	onSectionChange,
	onCompactionChange,
}: {
	agent: AgentSettings | undefined;
	/** The `compaction` section — its own PUT (the threshold is engine
	 *  behavior, not an agent-section key; owner round 14, Agent tab). */
	compaction: CompactionSettings | undefined;
	/** Writes the composed WHOLE agent section (replace-PUT discipline). */
	onSectionChange: (next: AgentSettings) => void;
	/** Writes the whole compaction section (replace-PUT discipline). */
	onCompactionChange: (next: CompactionSettings) => void;
}) {
	const [prompts, setPrompts] = useState<{ assistant: SegmentInfo[] } | null>(null);
	const [openSegment, setOpenSegment] = useState<string | null>(null);
	const [segmentDraft, setSegmentDraft] = useState<Record<string, string>>({});
	const [segmentStatus, setSegmentStatus] = useState<string | null>(null);

	/** Re-read the prompt-segment view — the signal seam for the
	 *  2026-09-26 state-echo fix: the view's `enabled` flags DERIVE from
	 *  the settings record's agent switches (the toggle's truth lives
	 *  here, not in the `agent` prop), so an agent-section write must
	 *  re-read it or the toggle keeps painting its pre-write state until
	 *  a remount. Keeps the last-good view on a failed re-read (the
	 *  initial mount fetch below owns the loading/null state). */
	const readPrompts = useCallback(() => {
		fetch("/api/settings/prompts")
			.then((r) => r.json())
			.then((body: { assistant: SegmentInfo[] }) => setPrompts(body))
			.catch(() => {});
	}, []);

	useSettingsSaved((section) => {
		// THE state-echo root cause: the prompt switches write through the
		// agent section, but this view (the toggles' truth) never re-read —
		// the settings-saved law (every reader re-reads) was missing this
		// one reader.
		if (section === "agent") readPrompts();
	});

	useEffect(() => {
		fetch("/api/settings/prompts")
			.then((r) => r.json())
			.then((body: { assistant: SegmentInfo[] }) => setPrompts(body))
			.catch(() => setPrompts(null));
	}, []);

	async function saveSegment(path: string, text: string) {
		setSegmentStatus(null);
		const res = await fetch(`/api/settings/prompts/${path}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text }),
		});
		if (!res.ok) {
			setSegmentStatus(`Save failed: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
			return;
		}
		readPrompts();
		setSegmentStatus("Saved");
		// Auto-on (owner ruling, refined 2026-09-26): writing an override and
		// putting it to work are ONE action — a save with the switch off was
		// the "did something, changed nothing" trap (the composed prompt
		// stayed the default). The file exists now, so the ON switch the
		// agent-section validation requires is legal; the order (file, then
		// switch) is the safe one. Saving an edit while already on rides
		// through — the switch write is idempotent at the record level.
		if (agent?.prompts?.[path] !== true) {
			onSectionChange(composePromptSwitch(agent, path, true));
		}
	}

	async function deleteSegment(path: string) {
		setSegmentStatus(null);
		const res = await fetch(`/api/settings/prompts/${path}`, { method: "DELETE" });
		if (!res.ok) {
			setSegmentStatus(`Delete failed: ${res.status}`);
			return;
		}
		// Auto-off — the mirror of save's auto-on: deleting the file while
		// the switch is on would orphan an ON record switch (the agent-section
		// validation 400s every later write while the UI's toggle can no
		// longer reach the OFF escape hatch — the trap found in live verify
		// 2026-09-26). Composing the OFF here keeps the record clean.
		if (agent?.prompts?.[path] === true) {
			onSectionChange(composePromptSwitch(agent, path, false));
		}
		readPrompts();
		setSegmentStatus("Deleted");
	}

	const segmentRow = (info: SegmentInfo) => {
		const fileExists = info.overrideText !== null;
		const open = openSegment === info.path;
		// The Save affordance (owner ruling, refined 2026-09-26): clickable
		// only when there's something to save — the draft differs from
		// what's on disk. An unchanged editor shows a grayed, inert Save
		// (the always-active button was the "doesn't feel like it does
		// anything" half of the report).
		const draft = segmentDraft[info.path] ?? info.overrideText ?? "";
		const dirty = draft !== (info.overrideText ?? "");
		return (
			<div key={info.path} data-testid={`prompt-segment-${info.path}`}>
				<SettingsRow
					label={info.path}
					// Overhaul rulings (2026-09-26, refined): the small text
					// states WHICH VERSION IS IN USE — nothing when the
					// default composes (even with a saved override sitting
					// on disk unused), "Your version is in use" when the
					// switch is on. The switch's meaning becomes legible
					// through this line.
					hint={info.enabled ? PROMPT_IN_USE_HINT : undefined}
					testid={`prompt-row-${info.path}`}
				>
					{/* Graying ruling: ONLY the toggle dims without an
					    override file — the file name above stays
					    full-contrast (the whole-row dim is dead). */}
					<span className={fileExists ? undefined : "opacity-40"}>
						<Toggle
							checked={info.enabled}
							disabled={!fileExists}
							label={`prompt ${info.path}`}
							onChange={(on) => onSectionChange(composePromptSwitch(agent, info.path, on))}
						/>
					</span>
				</SettingsRow>
				<button
					type="button"
					onClick={() => {
						setOpenSegment(open ? null : info.path);
						setSegmentStatus(null);
					}}
					className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
				>
					{open ? "Hide text" : "Show text"}
				</button>
				{open && (
					<div className="mt-1 flex flex-col gap-2">
						<div>
							<p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">Source</p>
							<textarea
								readOnly
								value={info.sourceText}
								aria-label="The original instructions"
								className="h-24 w-full resize-y rounded-sm border border-border bg-muted p-2 font-ui text-xs text-muted-foreground"
							/>
						</div>
						<div>
							<p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">Override</p>
							<OverrideTextarea
								value={draft}
								onChange={(v) => setSegmentDraft((d) => ({ ...d, [info.path]: v }))}
								onAppend={(t) => setSegmentDraft((d) => ({ ...d, [info.path]: joinDictation(d[info.path] ?? info.overrideText ?? "", t) }))}
								micKey={`prompt-override:${info.path}`} />
						</div>
						<div className="flex items-center gap-3">
							<button
								type="button"
								disabled={!dirty}
								onClick={() => void saveSegment(info.path, segmentDraft[info.path] ?? "")}
								className={
									dirty
										? "text-xs text-foreground underline-offset-2 hover:underline"
										: "cursor-not-allowed text-xs text-muted-foreground/40 underline-offset-2"
								}
							>
								Save
							</button>
							{fileExists && (
								<button
									type="button"
									onClick={() => void deleteSegment(info.path)}
									className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline"
								>
									Delete
								</button>
							)}
							{/* The quiet inline confirmation — next to the
							    action, not the old path-echoing line at the
							    section's bottom (production-copy: no file
							    paths in user-facing status). One editor is
							    open at a time (openSegment), so one shared
							    status reads unambiguously. */}
							{segmentStatus && (
								<p className="text-xs text-muted-foreground/70" data-testid="segment-status">
									{segmentStatus}
								</p>
							)}
						</div>
					</div>
				)}
			</div>
		);
	};



	// Resolved through the SAME core resolver the server's effective
	// settings use (the GraphSection precedent): the hint and placeholder
	// report exactly the number the trigger waits for.
	const resolvedCompaction = resolveSettings(
		compaction === undefined ? null : { version: 1, compaction },
	).compaction;

	return (
		<>
			<SettingsGroup label="Context" testid="group-context">
				<SettingsRow
					label="Compaction threshold"
					hint={`${resolvedCompaction.thresholdTokens} tok`}
					testid="compaction-row-threshold"
				>
					<CommitInput
						type="number"
						value={String(compaction?.thresholdTokens ?? "")}
						placeholder={String(resolvedCompaction.thresholdTokens)}
						ariaLabel="compaction threshold"
						testid="input-compaction-threshold"
						onCommit={(v) => {
							// Empty = factory default (the budget row's discipline):
							// absence is the unset for numbers.
							if (v === "") {
								onCompactionChange({ ...compaction, thresholdTokens: undefined });
								return;
							}
							const n = Number(v);
							if (!Number.isFinite(n) || n <= 0) return; // bad input: no write
							// Mirror the server floor (anti-churn: each compaction
							// keeps a ~20k-token tail); no ceiling — the effective
							// trigger is min(threshold, contextWindow − 16k) anyway.
							onCompactionChange({
								...compaction,
								thresholdTokens: Math.max(COMPACTION_THRESHOLD_FLOOR, Math.round(n)),
							});
						}}
					/>
				</SettingsRow>
			</SettingsGroup>

			<SettingsGroup label="System prompts" testid="group-prompts">
				{prompts === null ? (
					<p className="text-xs text-muted-foreground/70">Loading prompt segments…</p>
				) : (
					<div className="flex flex-col gap-4">
						{sectionedSegments(prompts).map((section) => (
							<div key={section.id} data-testid={`prompt-section-${section.id}`}>
								<p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">
									{section.label}
								</p>
								<div className="flex flex-col gap-2">
									{section.segments.map((info) => segmentRow(info))}
								</div>
							</div>
						))}
					</div>
				)}
			</SettingsGroup>
		</>
	);
}

/** The prompt-override editor: prose, so it carries an inline dictation mic (dictated text appends with joinDictation spacing). */
export function OverrideTextarea({ value, onChange, onAppend, micKey }: { value: string; onChange: (v: string) => void; onAppend: (t: string) => void; micKey: string }) {
	const mic = useFieldMic(micKey, onAppend);
	return (
		<div className="relative">
			<textarea
				value={value}
				onChange={(e) => onChange(e.target.value)}
				aria-label="Your version of the instructions"
				placeholder="Add your own instructions…"
				className="h-24 w-full resize-y rounded-sm border border-border bg-background p-2 pr-10 font-ui text-xs text-foreground outline-none"
			/>
			<InlineMic {...mic} className="absolute right-4 top-1.5" />
		</div>
	);
}
