/** The chat header's git tree: label, worktree badge, counts, popover, and nothing for a non-git thread. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	self: globalThis,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});

const { MockConsoleClient, FIXTURE_THREAD } = await import("@wolfpack/client");
type WorkspaceStatus = import("@wolfpack/client").WorkspaceStatus;
type ThreadWorkspace = import("@wolfpack/client").ThreadWorkspace;
const { ThreadGitTree, gitTreeLabel } = await import("../components/thread-git-tree.tsx");
const { threadFetch } = await import("./helpers/thread-fetch.ts");

const STATUS: WorkspaceStatus = {
	branch: "feat/abc1234-console",
	ahead: 2,
	behind: 1,
	dirty: [
		{ path: "src/a.ts", status: " M" },
		{ path: "new.txt", status: "??" },
	],
	commits: [
		{ sha: "a".repeat(40), subject: "add a", at: "2026-10-28T09:00:00.000Z" },
		{ sha: "b".repeat(40), subject: "initial", at: "2026-10-27T09:00:00.000Z" },
	],
	children: [{ threadId: "1uk4/sub-1", name: "Task 1", branch: "feat/abc1234-console--task-1", path: "/w/console/feat-abc1234-console--task-1" }],
};

const WS: ThreadWorkspace = { repo: "wolfpack", toplevel: "/w/console", base: "console", branch: "feat/abc1234-console", path: "/w/console/feat-abc1234-console", isWorktree: true };

class GitClient extends MockConsoleClient {
	constructor(private readonly status: WorkspaceStatus | null) {
		super({ delayMs: 0 });
	}
	async getWorkspaceStatus() {
		if (!this.status) throw new (await import("@wolfpack/client")).NotFoundError("no git");
		return this.status;
	}
}

const settle = (ms = 1300) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const click = (el: Element) => act(async () => void el.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true })));

const realFetch = globalThis.fetch;
let root: Root | null = null;
afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
	globalThis.fetch = realFetch;
});

async function mount(client: GitClient, workspace: ThreadWorkspace | undefined) {
	globalThis.fetch = threadFetch(client);
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	const slug = FIXTURE_THREAD.id.slice(FIXTURE_THREAD.wolf.length + 1);
	await act(async () => root!.render(<ThreadGitTree wolf={FIXTURE_THREAD.wolf} slug={slug} threadId={FIXTURE_THREAD.id} workspace={workspace} />));
	await settle();
}

describe("gitTreeLabel", () => {
	it("repo · base → branch; home has no base", () => {
		assert.equal(gitTreeLabel({ repo: "wolfpack", branch: "console" }), "wolfpack · console");
		assert.equal(gitTreeLabel(WS), "wolfpack · console → feat/abc1234-console");
	});
});

describe("ThreadGitTree", () => {
	it("renders the tree, the worktree badge and the counts", async () => {
		await mount(new GitClient(STATUS), WS);
		assert.equal(q('[data-testid="git-tree-label"]')!.textContent, "wolfpack · console → feat/abc1234-console");
		assert.ok(q('[data-testid="git-tree-worktree"]'));
		assert.equal(q('[data-testid="git-tree-dirty"]')!.textContent, "±2");
		assert.equal(q('[data-testid="git-tree-ahead"]')!.textContent, "↑2");
		assert.equal(q('[data-testid="git-tree-behind"]')!.textContent, "↓1");
		assert.equal(q('[data-testid="git-tree-popover"]'), null);
	});

	it("no worktree badge or counts for a clean main checkout", async () => {
		await mount(new GitClient({ ...STATUS, branch: "console", ahead: 0, behind: 0, dirty: [], children: [] }), { repo: "wolfpack", toplevel: "/r", branch: "console", path: "/r", isWorktree: false });
		assert.equal(q('[data-testid="git-tree-label"]')!.textContent, "wolfpack · console");
		assert.equal(q('[data-testid="git-tree-worktree"]'), null);
		assert.equal(q('[data-testid="git-tree-dirty"]'), null);
	});

	it("click opens the popover: path, branch, dirty files, commits, subagent worktrees", async () => {
		await mount(new GitClient(STATUS), WS);
		await click(q('[data-testid="git-tree-button"]')!);
		const pop = q('[data-testid="git-tree-popover"]')!;
		assert.ok(pop);
		assert.equal(q('[data-testid="git-tree-path"]')!.textContent, WS.path);
		assert.ok(q('[data-testid="git-tree-copy"]'));
		assert.match(q('[data-testid="git-tree-branch"]')!.textContent!, /feat\/abc1234-console \(from console\)/);
		const dirty = q('[data-testid="git-tree-dirty-files"]')!.textContent!;
		assert.match(dirty, /src\/a\.ts/);
		assert.match(dirty, /new\.txt/);
		const commits = q('[data-testid="git-tree-commits"]')!.textContent!;
		assert.match(commits, /aaaaaaa.*add a/);
		assert.match(commits, /initial/);
		assert.match(q('[data-testid="git-tree-children"]')!.textContent!, /Task 1[\s\S]*feat\/abc1234-console--task-1/);
		await click(q('[data-testid="git-tree-button"]')!);
		assert.equal(q('[data-testid="git-tree-popover"]'), null);
	});

	it("draws nothing for a non-git thread, and fetches nothing", async () => {
		let fetched = 0;
		const client = new GitClient(null);
		await mount(client, undefined);
		const inner = globalThis.fetch;
		globalThis.fetch = ((...a: Parameters<typeof fetch>) => (fetched++, inner(...a))) as typeof fetch;
		await settle(50);
		assert.equal(q('[data-testid="git-tree"]'), null);
		assert.equal(document.body.textContent, "");
		assert.equal(fetched, 0);
	});
});
