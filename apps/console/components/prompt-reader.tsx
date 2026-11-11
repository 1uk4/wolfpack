"use client";

/**
 * The Prompts reader: ONE flat view of a prompt for the graph's side panel. The prompt is rendered (markdown, `{{var}}` chips,
 * a frontmatter strip for profiles); Edit swaps the body for a textarea. Details (source, used by, scope, backups) sit behind a
 * small toggle at the bottom. State that must survive (drafts, errors, the PUT / DELETE calls) is owned by the page.
 */
import { useState, type ReactNode } from "react";
import { InfoIcon, LockIcon, PencilIcon } from "lucide-react";
import { KbMarkdown } from "@/components/kb/kb-markdown";
import { HOST_LABEL, type Host } from "../src/core/prompt-flows.ts";
import { parseFrontmatter, readerModeOf, splitVars } from "../src/core/prompt-reader.ts";

export interface ReaderRow {
	id: string;
	group: string;
	label: string;
	editable: boolean;
	text: string;
	source: "default" | "override";
	kind?: string;
	file?: string;
	user?: string;
	scope?: "wolf" | "global" | "hub";
	contract?: string;
	applies?: string;
	projectOverride?: boolean;
	inlineIdentity?: string;
	hasOriginal?: boolean;
}

const btn = "rounded border px-3 py-1 text-sm disabled:opacity-50";

function VarChip({ name }: { name: string }) {
	return <span className="mx-0.5 rounded bg-accent px-1.5 py-0.5 font-mono text-[11px] text-accent-foreground" data-testid="prompt-var-chip">{name}</span>;
}

/** A template: monospace, each `{{var}}` an inline chip. */
function TemplateBody({ text }: { text: string }) {
	return (
		<pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5" data-testid="prompt-reader-body">
			{splitVars(text).map((seg, i) => ("variable" in seg ? <VarChip key={i} name={seg.variable} /> : <span key={i}>{seg.text}</span>))}
		</pre>
	);
}

function ProfileBody({ text }: { text: string }) {
	const { fields, body } = parseFrontmatter(text);
	const description = fields.find(([k]) => k === "description")?.[1];
	return (
		<div className="flex flex-col gap-3" data-testid="prompt-reader-body">
			{fields.length > 0 && (
				<dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs" data-testid="prompt-frontmatter">
					{fields.filter(([k]) => k !== "description").map(([k, v]) => (
						<div key={k} className="flex gap-1.5"><dt className="text-muted-foreground">{k}</dt><dd className="font-mono">{v}</dd></div>
					))}
					{description && <p className="w-full text-muted-foreground">{description}</p>}
				</dl>
			)}
			<KbMarkdown density="normal">{body}</KbMarkdown>
		</div>
	);
}

export function PromptReader(p: {
	row: ReaderRow;
	host: Host;
	hideHeader?: boolean;
	closeButton?: ReactNode;
	editedIn?: { id: string; label: string };
	onOpenNode: (id: string) => void;
	usedBy?: string[];
	/** The unsaved text, if any. */
	draft: string | undefined;
	setDraft: (t: string) => void;
	clearDraft: () => void;
	error: string;
	/** True when the server accepted the change. */
	onSave: () => Promise<boolean>;
	onReset: () => Promise<boolean>;
	/** Set for the wolf.yaml-backed structured-output block: its own editor replaces the textarea. */
	structuredEditor?: ReactNode;
}) {
	const { row } = p;
	const [editing, setEditing] = useState(false);
	const [saved, setSaved] = useState(false);
	const canEdit = row.editable || !!p.structuredEditor;
	const draft = p.draft ?? row.text;
	const mode = readerModeOf(row);
	const isIdentity = row.id === "identity";
	const done = async (go: Promise<boolean>) => {
		if (await go) {
			setEditing(false);
			setSaved(true);
		}
	};

	const marker = row.editable || p.structuredEditor ? <PencilIcon className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-label="editable" role="img" /> : <LockIcon className="size-3.5 text-muted-foreground" aria-label="read-only" role="img" />;
	const header = !p.hideHeader && (
		<header className="flex items-center gap-2" data-testid="prompt-reader-header">
			<h2 className="min-w-0 flex-1 text-base font-semibold leading-tight">{row.label}</h2>
			{row.source === "override" && <span className="size-2 shrink-0 rounded-full bg-amber-500" title="overridden" aria-label="overridden" role="img" data-testid="prompt-overridden" />}
			{marker}
			{p.host !== "wolf" && <span className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground" data-testid="prompt-host-chip">{HOST_LABEL[p.host]}</span>}
			{canEdit && !editing && <button type="button" className="rounded border px-2 py-0.5 text-xs hover:bg-accent" onClick={() => { setSaved(false); setEditing(true); }} data-testid="prompt-edit">Edit</button>}
			{p.closeButton}
		</header>
	);

	return (
		<section className="flex min-w-0 flex-col gap-3" data-testid={`prompt-reader-${row.id}`}>
			{header}
			{p.editedIn && mode === "composed" && (
				<button type="button" className="self-start text-xs underline" onClick={() => p.onOpenNode(p.editedIn!.id)} data-testid="prompt-edit-link">Edit in {p.editedIn.label} →</button>
			)}
			{saved && !editing && <p className="text-xs text-muted-foreground" data-testid="prompt-saved-note">Saved. {row.applies ? `Applies ${row.applies}.` : "Applies when the wolf restarts."}</p>}
			{row.editable && row.inlineIdentity && <p className="text-xs text-destructive" data-testid={`prompt-inline-identity-${row.id}`}>wolf.yaml sets <span className="font-mono">identity: {row.inlineIdentity}</span>, which the running wolf reads instead of this file. An edit is saved but has no effect until that line is removed.</p>}
			{row.editable && row.projectOverride && <p className="text-xs text-destructive" data-testid={`prompt-project-override-${row.id}`}>This workspace has its own .pi file for it, which wins over an edit made here.</p>}

			{editing && p.structuredEditor ? (
				<div className="flex flex-col gap-2">
					{p.structuredEditor}
					<button type="button" className={`${btn} self-start`} onClick={() => setEditing(false)}>Close editor</button>
				</div>
			) : editing ? (
				<div className="flex flex-col gap-2">
					<p className="text-xs text-muted-foreground" data-testid="prompt-restart-note">Applies {row.applies ?? "when the wolf restarts"}. The previous version is kept as a backup (last 10).</p>
					<textarea className="h-[50vh] w-full rounded border bg-background p-2 font-mono text-xs" value={draft} onChange={(e) => p.setDraft(e.target.value)} data-testid={`prompt-text-${row.id}`} />
					{p.error && <p className="text-sm text-destructive" role="alert" data-testid={`prompt-error-${row.id}`}>{p.error}</p>}
					<div className="flex flex-wrap gap-2">
						<button className={btn} disabled={draft === row.text} onClick={() => void done(p.onSave())} data-testid={`prompt-save-${row.id}`}>Save</button>
						<button className={btn} onClick={() => { p.clearDraft(); setEditing(false); }} data-testid="prompt-cancel">Cancel</button>
						<button
							className={btn}
							disabled={isIdentity ? row.hasOriginal !== true : row.source === "default"}
							title={isIdentity && row.hasOriginal !== true ? "No original to restore: the identity has not been edited here yet" : undefined}
							onClick={() => void done(p.onReset())}
							data-testid={`prompt-reset-${row.id}`}
						>{isIdentity ? "Restore original" : "Reset to default"}</button>
					</div>
				</div>
			) : (
				<div className="min-w-0" data-testid={`prompt-text-${row.id}`}>
					{mode === "template" ? <TemplateBody text={row.text} /> : mode === "profile" ? <ProfileBody text={row.text} /> : <div data-testid="prompt-reader-body"><KbMarkdown density="normal">{row.text}</KbMarkdown></div>}
				</div>
			)}

			{!editing && p.error && <p className="text-sm text-destructive" role="alert" data-testid={`prompt-error-${row.id}`}>{p.error}</p>}
			{row.contract && (
				<details data-testid={`prompt-contract-${row.id}`}>
					<summary className="cursor-pointer text-xs text-muted-foreground">Output contract</summary>
					<pre className="mt-1 overflow-x-auto rounded border bg-muted/30 p-2 font-mono text-xs">{row.contract}</pre>
				</details>
			)}
			<details className="text-xs text-muted-foreground" data-testid="prompt-details">
				<summary className="inline-flex cursor-pointer items-center gap-1" aria-label="Details"><InfoIcon className="size-3.5" aria-hidden />Details</summary>
				<dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
					{row.file && (<><dt>Source</dt><dd className="break-all font-mono">{row.file}</dd></>)}
					{row.user && (<><dt>Used by</dt><dd>{row.user}</dd></>)}
					{row.scope && (<><dt>Scope</dt><dd>{row.scope === "wolf" ? "per wolf" : row.scope}</dd></>)}
					{p.usedBy && (<><dt>Read by</dt><dd>{p.usedBy.length ? p.usedBy.join(", ") : "no profile names it"}</dd></>)}
					<dt>Version</dt><dd>{row.source === "override" ? "overridden" : "default"}</dd>
					{row.editable && (<><dt>Backups</dt><dd>the previous version is kept (last 10){isIdentity ? "; Restore original puts back the identity as it was before its first edit here" : ""}</dd></>)}
				</dl>
			</details>
		</section>
	);
}

/** Tools (n): name and rendered description, compact. */
export function ToolsReader({ rows }: { rows: ReaderRow[] }) {
	return (
		<ul className="flex flex-col divide-y" data-testid="tools-reader">
			{rows.map((r) => (
				<li key={r.id} className="flex flex-col gap-0.5 py-2" data-testid={`tool-${r.id}`}>
					<span className="font-mono text-xs font-medium">{r.label}</span>
					<KbMarkdown density="compact">{r.text}</KbMarkdown>
				</li>
			))}
		</ul>
	);
}
