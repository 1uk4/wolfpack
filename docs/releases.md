# Releases: the owner-merged PR flow

Agents never merge a PR and never push `stable`. They open a PR that explains itself, and the owner merges it on GitHub. (`prepare` pushes only the `wolf/<wolf>` branch, without force.)

## The flow
1. **Task**: a worker finishes a task on its `feat/...` branch (see the [git standard](../packages/agents/standards/git.md)).
2. **Auto-merge** into `wolf/<wolf>` when the task is done. This is the integration branch.
3. **`wolfpack pr prepare`**, run from the `wolf/<wolf>` worktree. It checks that the tree is clean and `gh` is authenticated, looks up an open PR for the branch, merges `origin/stable` into the wolf branch (a merge commit, aborted on conflict), builds and tests it, then pushes the wolf branch (no force) and opens or updates the PR into `stable`.
4. **The owner merges** the PR on GitHub with a **merge commit**. The release keeps its history, so it is not squashed.
5. **`wolfpack pr post-merge --apply`**: bookkeeping only.

`prepare --dry-run` and `post-merge` without `--apply` only print what would happen; use them first when unsure.

### `wolfpack pr prepare [--full] [--dry-run] [--base stable]`
- Title: `Release <wolf> <date>: N features`. Features come from the work item IDs in the commit subjects (`origin/stable..HEAD`); commits with no readable ID go under **Other commits**.
- Body, in order: the **Decide** header (what merging does, per-feature risk, rollback, per-feature manual checks, a warning for work items that could not be read), **Tests and CI** totals, one section per feature (diagram, before/after screenshots linked from `docs/pr-assets/<id>/` (**commit the screenshots**: only tracked files are linked; an untracked or ignored image is not shown), the full feature document), then Other commits.
- Without `--full` it tests the affected packages; `--full` runs everything.
- `--base` exists only to be explicit: `stable` is the only value accepted, anything else is refused.
- Refuses before changing anything on a dirty tree (the console's generated `apps/console/next-env.d.ts` does not count), a branch that is not `wolf/*`, no `gh` login, a missing Work API config, a base other than `stable`, a failed or unreadable lookup of the existing PR, a failed ancestor check against `origin/stable` (anything other than "not an ancestor"), nothing to release, or a failing build or test.
- It never calls `gh pr merge` and never pushes `stable`.

### `wolfpack pr post-merge [--dry-run] [--apply]`
- Without `--apply` it fetches `refs/remotes/origin/stable` and prints the plan; nothing else changes. `--dry-run` does not fetch.
- **It moves only `stable` and the current wolf's branch.** The current wolf is read from the worktree you run it in (real path of `git rev-parse --show-toplevel`, and the branch of its HEAD). Run from a `wolf/<name>` worktree, it fast-forwards `stable` and that worktree. Run from any other branch (for example a `feat/*` worktree) or a detached HEAD, it fast-forwards only `stable` and says the wolf branch was not touched. Other wolves' `wolf/*` branches are never moved. There is no `--wolf` flag.
- Fast-forwards use `git merge --ff-only origin/stable` in the worktree (found with `git worktree list`). A dirty worktree is skipped; one that has diverged is skipped; one that is ahead of `origin/stable` is left as it is. It builds only the worktrees it moved.
- **Strict dirty rule:** untracked files count as dirty, because removing a worktree must never lose them. Only the generated `apps/console/next-env.d.ts` is ignored. (`runtime:update` is looser: it ignores untracked files and checks only tracked changes.)
- **Cleanup needs proof that the branch was merged.** A `feat/*` branch is cleaned up only if its tip is in `origin/stable` and one of these holds: its reflog (`git reflog show --format=%gs`) has at least one `commit` entry (`commit`, `commit (merge)`, `commit (amend)`, `commit (initial)`), or (when there is no reflog) its tip is a non-first parent of a merge commit reachable from `origin/stable`. A branch whose tip equals the tip of `stable`, `origin/stable` or any `wolf/*` branch, or whose reflog shows only movement (fast-forward, reset, merge) and no commit, is left alone with "can't prove it was merged; left alone". Branches not in `origin/stable` are never touched. **Removing a worktree also deletes its ignored files** (a local `.env`, notes, scratch): move anything you want to keep out of a `feat/*` worktree before you run `post-merge --apply`. Dirty worktrees are kept, but ignored files do not make a worktree dirty.
- Cleaning up a proven branch (the keep checks for the current worktree, the main checkout and the current HEAD's branch run first, so nothing is archived for a branch that is kept): create `refs/archive/<branch>` at the tip (never overwriting one that points elsewhere; then the branch and its worktree are kept), remove its worktree if clean (never the current worktree, a worktree whose branch is the current HEAD's branch, or the main checkout; paths are compared by real path), delete the branch with `git branch -d`.
- The build is `pnpm install --frozen-lockfile --prefer-offline` then `node scripts/turbo.mjs run build` in each worktree that moved (a checkout without `pnpm-lock.yaml`, or without pnpm, keeps `npx turbo run build`): the same commands as `runtime:update`. (The root `pnpm run build` is plain `tsc --build`, which is not what the runtime uses.)
- It never merges a PR, pushes or rebases.
- `pnpm runtime:update` then follows `origin/stable` for the live stack (fetch, fast-forward, build, refresh extensions); it no longer merges or pushes. **It needs to reach `origin`**: offline, only `pnpm runtime:update --dry-run` works (it does not fetch). `post-merge` also fetches, so offline only `--dry-run` works there too.

## The `## Release notes` format
Put this in the feature document. `prepare` reads it to fill the Decide header; the notes also stay in the document.

```markdown
## Release notes
Risk: one line saying what could go wrong
Manual checks:
- first thing the owner should look at
- second thing
```
- The heading is case-insensitive. The section ends at the next `#` or `##` heading.
- `Risk:` is one line.
- `Manual checks:` is on its own line, followed by `-` or `*` bullets.
- The first line-anchored ` ```mermaid ` block in the document is the diagram; it is shown in its own place and removed from the document text. A heading or fence inside another code fence does not count.
- Anything missing shows as "not provided" for that feature; it is never dropped silently.

## Keep feature documents lean
Write what a reviewer needs and add detail only where the feature needs it. Nothing is cut: `prepare` has no size limit of its own. What does not fit in the PR body (65,536 bytes) goes, whole and in order, to PR comments (marked `<!-- wolfpack-release-part:N -->`, long sections split at line boundaries with fences closed and reopened); the body ends with "Continued in comments: ...". If the Risk and Manual checks lists, or the list of unreadable work items, would not fit in the body, they move to the first comment.

## Re-running prepare
Running `prepare` again updates the same PR. It **overwrites the PR body** and **edits its own comments** (only comments it wrote, with its marker, as the authenticated `gh` user) in place, adds new ones, and deletes leftovers. **Any edit the owner made to the body or to those comments is lost.** The owner's own comments are never touched. Put owner notes in a separate comment.

## One-commit fixes: the `fixes` branch
A fix that belongs to no feature does not get its own PR. A standing `fixes` branch, cut from `stable`, collects those one-commit fixes and is opened as **one rolling PR** weekly, or when it holds 5 commits. A lone PR is only for a fix the owner calls urgent. This is a convention; there is no command for it.

## Owner actions (agents never do these)
- On the `stable` ruleset: require a pull request and the `ci` check, allow merge commits, keep the owner as the bypass actor.
- Confirm that agent tokens cannot merge pull requests.
