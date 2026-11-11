# Releases: the owner-merged PR flow

Agents never merge a PR and never push `stable`. They open a PR that explains itself, and the owner merges it on GitHub. (`prepare` pushes only the `wolf/<wolf>` branch, without force.)

## The flow
1. **Task**: a worker finishes a task on its `feat/...` branch (see the [git standard](../packages/agents/standards/git.md)).
2. **Auto-merge** into `wolf/<wolf>` when the task is done. This is the integration branch.
3. **`wolfpack pr prepare`**, run from the `wolf/<wolf>` worktree. It checks that the tree is clean and `gh` is authenticated, looks up an open PR for the branch, merges `origin/stable` into the wolf branch (a merge commit, aborted on conflict), builds and tests it, then pushes the wolf branch (no force) and opens or updates the PR into `stable`.
4. **The owner merges** the PR on GitHub with a **merge commit**. The release keeps its history, so it is not squashed.
5. **`wolfpack pr post-merge --apply`**: bookkeeping only.

`prepare --dry-run` and `post-merge` without `--apply` only print what would happen; use them first when unsure.

### `wolfpack pr prepare [--full] [--skip-live] [--dry-run] [--base stable]`
- Title: `Release <wolf> <date>: N features`. Features come from the work item IDs in the commit subjects (`origin/stable..HEAD`); commits with no readable ID go under **Other commits**.
- Body, in order: the **Decide** header (what merging does, per-feature risk, rollback, per-feature manual checks, a warning for work items that could not be read), **Tests and CI** totals, one section per feature (diagram, before/after screenshots linked from `docs/pr-assets/<id>/` (**commit the screenshots**: only tracked files are linked; an untracked or ignored image is not shown), the full feature document), then Other commits.
- Without `--full` it tests the affected packages; `--full` runs everything. It then runs `pnpm run test:live` (real Claude through your login, so run it on your Mac). `--skip-live` omits that, and the PR body's live/eval line says it was skipped.
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
- `runtime:update` stamps each component's `VERSION` (`scripts/release-version.mjs --stamp-runtime`) from the newest `<component>/vX.Y.Z` tag reachable from the checkout. A working branch (e.g. `wolf/1uk4`) only sees tags merged back into it, so until stable is merged back the console sidebar shows "update available". That is correct: the Mac really is behind stable. Merge stable back and re-run `runtime:update` to clear it.
- **Automatic updates (opt-in, UNVERIFIED on hosts):** each host polls the stable manifest and updates itself. sfo-01 uses a systemd timer and `scripts/auto-update.mjs`, which verifies the asset against GitHub's digest, runs `deploy-release.sh --sha256 <that digest>` and health-checks. The Mac uses launchd and `scripts/auto-update-mac.mjs`, which runs `runtime:update`, then `stack restart`, then health-checks. A failure is recorded and left as it is, and the same version is never retried by itself, not even after a pause and resume. Status: console `/api/updates` (`updateStatus`, sfo-01) and `pnpm stack status` (Mac). Setup and the kill switch: `deploy/auto-update/RUNBOOK.md`.

## The `main` testing channel (work-wolfpack-pr6t1Y9)
A second channel for trying work before it reaches `stable`. Tags are `<component>/vX.Y.Z-main.N` (GitHub prereleases); stable ignores them.
- **Publish:** `wolfpack release publish [--ref wolf/1uk4]` runs the `release-main.yml` workflow (workflow_dispatch). It tags, builds and uploads the prerelease assets, and publishes `main.json` to the `main-manifest` release (next to `stable.json` on `stable-manifest`). `main.json` also carries `channel`, `ref` and `sha`.
- **Subscribe:** each host has `{schema:1, channel: stable|main, mode: off|button|auto}`. sfo-01: `/var/lib/wolfpack-subscription/subscription.json` (its own root:console 0775 directory, so the console never writes the root-only updater state dir); Mac: `~/.wolfpack/release-channel.json`. No file means stable + button (today's behaviour, with `WOLFPACK_AUTO_UPDATE=1` still the opt-in; a corrupt file is logged and treated as no file). `GET` reports the effective mode: with no file, `auto` if `WOLFPACK_AUTO_UPDATE=1` is in the console's env, else `button`, or `unknown` when the console cannot tell (the panel shows "not set (host default)"). The pack panel writes it through `PUT /api/health/subscription` (device bearer).
- **Pack panel:** one card per service (console, hubd, wolfd, workerd) with Update and Roll back; an auto switch and, under Advanced, the channel picker. `POST /api/health/update` takes an optional `{component}`.
- **Rules:** wolfd is never updated by a timer run (button only), including the no-settings-file `WOLFPACK_AUTO_UPDATE=1` path. A manual rollback holds the version rolled back from, so timer runs do not reinstall it; any manual Update (Update all, a card's button, `--now [--only]`) bypasses the hold, because the owner asked. The rollback unit's hold is best effort (`-` prefix): a failed hold prints a WARNING to the journal but never blocks the rollback. `mode: off` blocks manual updates too. The stable planner skips commits already tagged `-main` (fine for merge commits). `wolfpack release publish` dispatches `release-main.yml` from `--ref` (default `wolf/1uk4`), so it works before the workflow reaches stable; the workflow shares the `release-stable` concurrency group, so a second dispatch while one runs stays pending and a third replaces it. A failed health check does not switch channel back. The Mac checks out the exact `sha` of `main.json` (`runtime-update.mjs --sha`).

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
- The `ci` check is affected-only for feature work. For a PR into `stable` (and a push to `stable`) it runs everything: full vitest default project, console tests, tracer, release-smoke and the `eval` job. Live tests are not in CI; `wolfpack pr prepare` runs them. See `docs/testing.md`.
- Confirm that agent tokens cannot merge pull requests.
