"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon, GitBranchIcon } from "lucide-react";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { useOptionalServerEvent } from "@/components/server-events";
import { threadBase } from "@/components/thread-transport";
import { BranchGraphView } from "@/components/branch-graph";
import type { BranchGraph } from "@/src/core/branch-graph";
import type { ThreadWorkspace, WorkspaceStatus } from "@wolfpack/client";

/** The header's repo · base → branch label (a home thread has no base). */
export function gitTreeLabel(ws: Pick<ThreadWorkspace, "repo" | "base" | "branch">): string {
	return `${ws.repo} · ${ws.base ? `${ws.base} → ` : ""}${ws.branch}`;
}

/** Branch names longer than this get their middle elided (the full name stays in the title). */
export const BRANCH_MAX_CHARS = 56;

/** Elide the middle of a long name: `feat/abc…ents-x`. Short names pass through. */
export function middleTruncate(name: string, max = BRANCH_MAX_CHARS): string {
	if (name.length <= max) return name;
	if (max < 2) return "…";
	const keep = max - 1;
	const head = Math.ceil(keep / 2);
	return `${name.slice(0, head)}…${name.slice(name.length - (keep - head))}`;
}

/** Refresh at most once per this many ms while events keep coming (a trailing call always lands). */
const REFRESH_GAP_MS = 1000;

/**
 * The thread's live git status, for the header: fetched on mount, on `refreshKey` (a turn ended), on a thread-updated
 * of this thread or one of its subagents, and on window focus. Calls close together are coalesced.
 */
export function useWorkspaceStatus(wolf: string, slug: string, threadId: string, enabled: boolean, refreshKey?: unknown): WorkspaceStatus | undefined {
	const [status, setStatus] = useState<WorkspaceStatus>();
	const seq = useRef(0);
	const last = useRef(0);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const fetchNow = useCallback(async () => {
		const n = ++seq.current;
		last.current = Date.now();
		try {
			const res = await fetch(`${threadBase(wolf, slug)}/workspace`);
			if (!res.ok || n !== seq.current) return;
			setStatus((await res.json()) as WorkspaceStatus);
		} catch {
			/* the next trigger refetches */
		}
	}, [wolf, slug]);
	const refresh = useCallback(() => {
		if (!enabled || timer.current) return;
		const wait = Math.max(0, last.current + REFRESH_GAP_MS - Date.now());
		timer.current = setTimeout(() => {
			timer.current = undefined;
			void fetchNow();
		}, wait);
	}, [enabled, fetchNow]);
	useEffect(() => {
		refresh();
	}, [refresh, refreshKey]);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
			timer.current = undefined;
		},
		[],
	);
	useEffect(() => {
		if (!enabled) return;
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [enabled, refresh]);
	useOptionalServerEvent("thread-updated", (p) => {
		if (p.wolf === wolf && (p.thread.id === threadId || p.thread.parentThreadId === threadId)) refresh();
	});
	return status;
}

/** The branch graph for the popover: fetched while it is open and again when the git status changes. */
function useBranchGraph(wolf: string, slug: string, enabled: boolean, status: WorkspaceStatus | undefined): BranchGraph | undefined {
	const [graph, setGraph] = useState<BranchGraph>();
	useEffect(() => {
		if (!enabled) return;
		let live = true;
		void (async () => {
			try {
				const res = await fetch(`${threadBase(wolf, slug)}/workspace/graph`);
				if (res.ok && live) setGraph((await res.json()) as BranchGraph);
			} catch {
				/* the graph is a preview; the list below still works */
			}
		})();
		return () => {
			live = false;
		};
	}, [wolf, slug, enabled, status]);
	return graph;
}

async function copyPath(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

/**
 * The chat header's git tree: `repo · base → branch` with a worktree badge and dirty / ahead / behind counts. Click
 * opens the popover (path with copy, branch, dirty files, last commits, running subagents' worktrees). Draws nothing
 * for a thread without a git workspace.
 */
export function ThreadGitTree({ wolf, slug, threadId, workspace, refreshKey }: { wolf: string; slug: string; threadId: string; workspace?: ThreadWorkspace; refreshKey?: unknown }) {
	const status = useWorkspaceStatus(wolf, slug, threadId, workspace !== undefined, refreshKey);
	const [open, setOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const graph = useBranchGraph(wolf, slug, open, status);
	usePopoverDismiss(rootRef, open, () => setOpen(false));
	if (!workspace) return null;
	const branch = status?.branch ?? workspace.branch;
	return (
		<div ref={rootRef} className="relative min-w-0 shrink" data-testid="git-tree">
			<button
				type="button"
				data-testid="git-tree-button"
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-label={gitTreeLabel({ ...workspace, branch })}
				title={gitTreeLabel({ ...workspace, branch })}
				onClick={() => setOpen((v) => !v)}
				className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent"
			>
				<GitBranchIcon className="size-3 shrink-0" />
				<span data-testid="git-tree-label" className="flex min-w-0 items-center overflow-hidden whitespace-pre font-mono">
					<span title={workspace.repo} className="min-w-0 shrink truncate text-foreground/80">{workspace.repo}</span>
					<span className="shrink-0 text-muted-foreground/60">{" · "}</span>
					{workspace.base && (
						<>
							<span data-testid="git-tree-base" title={workspace.base} className="min-w-0 shrink truncate rounded border border-border px-1">{middleTruncate(workspace.base)}</span>
							<span data-testid="git-tree-arrow" aria-hidden className="shrink-0 text-foreground/70">{" → "}</span>
						</>
					)}
					<span data-testid="git-tree-current" title={branch} className="min-w-0 truncate rounded border border-border bg-accent/40 px-1 text-foreground">{middleTruncate(branch)}</span>
				</span>
				{workspace.isWorktree && (
					<span data-testid="git-tree-worktree" className="shrink-0 rounded border border-border px-1 text-[10px] uppercase tracking-wide">
						worktree
					</span>
				)}
				{status && status.dirty.length > 0 && (
					<span data-testid="git-tree-dirty" title="uncommitted files" className="shrink-0 tabular-nums">
						±{status.dirty.length}
					</span>
				)}
				{status && status.ahead > 0 && (
					<span data-testid="git-tree-ahead" title={`ahead of ${workspace.base ?? "base"}`} className="shrink-0 tabular-nums">
						↑{status.ahead}
					</span>
				)}
				{status && status.behind > 0 && (
					<span data-testid="git-tree-behind" title={`behind ${workspace.base ?? "base"}`} className="shrink-0 tabular-nums">
						↓{status.behind}
					</span>
				)}
			</button>
			{open && (
				<div role="dialog" aria-label="Git workspace" data-testid="git-tree-popover" className="absolute left-0 top-full z-50 mt-1 flex w-96 max-w-[90vw] flex-col gap-2 rounded-lg border border-border bg-popover p-3 text-xs shadow-lg">
					<div className="flex items-center gap-1.5">
						<span data-testid="git-tree-path" className="min-w-0 flex-1 break-all font-mono">
							{workspace.path}
						</span>
						<button
							type="button"
							data-testid="git-tree-copy"
							aria-label="Copy path"
							className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent"
							onClick={() => {
								void copyPath(workspace.path).then((ok) => {
									setCopied(ok);
									if (ok) setTimeout(() => setCopied(false), 1500);
								});
							}}
						>
							{copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
						</button>
					</div>
					<div data-testid="git-tree-branch" className="font-mono text-muted-foreground">
						{branch}
						{workspace.base ? ` (from ${workspace.base})` : ""}
					</div>
					{!status ? (
						<div className="text-muted-foreground">Loading…</div>
					) : (
						<>
							<section data-testid="git-tree-dirty-files">
								<div className="mb-0.5 uppercase tracking-widest text-muted-foreground/70">Changes</div>
								{status.dirty.length === 0 ? (
									<div className="text-muted-foreground">clean</div>
								) : (
									status.dirty.map((f) => (
										<div key={f.path} className="flex gap-2 font-mono">
											<span className="w-5 shrink-0 whitespace-pre text-muted-foreground">{f.status}</span>
											<span className="min-w-0 break-all">{f.path}</span>
										</div>
									))
								)}
							</section>
							{graph && graph.commits.length > 0 && (
								<section data-testid="git-tree-graph">
									<div className="mb-0.5 uppercase tracking-widest text-muted-foreground/70">Branches</div>
									<BranchGraphView graph={graph} />
								</section>
							)}
							<section data-testid="git-tree-commits">
								<div className="mb-0.5 uppercase tracking-widest text-muted-foreground/70">Recent commits</div>
								{status.commits.map((c) => (
									<div key={c.sha} className="flex gap-2">
										<span className="shrink-0 font-mono text-muted-foreground">{c.sha.slice(0, 7)}</span>
										<span className="min-w-0 truncate">{c.subject}</span>
									</div>
								))}
							</section>
							{status.children.length > 0 && (
								<section data-testid="git-tree-children">
									<div className="mb-0.5 uppercase tracking-widest text-muted-foreground/70">Subagent worktrees</div>
									{status.children.map((c) => (
										<div key={c.threadId} className="flex flex-col">
											<span>{c.name}</span>
											<span className="break-all font-mono text-muted-foreground">{c.branch}</span>
										</div>
									))}
								</section>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}

/** The header's second row: the git tree on its own full-width line; renders nothing (no gap) for a non-git thread. */
export function ThreadGitRow(props: { wolf: string; slug: string; threadId: string; workspace?: ThreadWorkspace; refreshKey?: unknown }) {
	if (!props.workspace) return null;
	return (
		<div data-testid="thread-header-row2" className="flex h-7 shrink-0 items-center border-b border-border/60 px-3">
			<ThreadGitTree wolf={props.wolf} slug={props.slug} threadId={props.threadId} workspace={props.workspace} refreshKey={props.refreshKey} />
		</div>
	);
}
