# Git standard

Applies to every commit made by an agent in this repo.
Goal: a short, readable history where each commit is one behaviour change you can revert on its own.
Reviewers only check against this standard; they never commit, fix up or rebase.

## 1. The commit unit
- A commit is one behaviour change plus its tests.
- A second commit is allowed only for a separate refactor or a docs change.
- A typical task is 1-2 commits.

## 2. Reduce your branch
- Fold review fixes and corrections into the commit they belong to. No "address review" or "fix typo" commits.
- Record the fix with `git commit --fixup <sha> -- <paths>` (`git add` a new file first), then squash it in:
  `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash <base>`
- `<base>` is the commit the task branch started from: `base=$(git merge-base HEAD <parent-branch>)`, where `<parent-branch>` is the branch your worktree was cut from (the brief names it, or it is the feature branch).
  If you cannot determine it with certainty, do not rebase; report it.
- Rebase only your own unmerged `feat/...` task branch with a clean tree. If the tree has changes that are not yours, or you are not on a task branch, do not rebase; report it.
- Never use `--autostash`, stash or reset to get a clean tree. Never merge the parent into your branch.
- The autosquash rebase above is the only rebase a worker may run. Moving a branch onto a new base (`git rebase <branch>`) is blocked for workers; the orchestrator thread does it and hands the worker the resolved branch.
- The worker reduces its own branch before reporting done. After task_done the branch is merged and section 4 applies.
- `workspaces.autosquash` (wolf.yaml, off by default): when on, wolfd folds a task branch's `fixup!` commits at ship. While it is off, the self-squash above still applies; that step will be removed when the flag defaults on.

## 3. Messages
- Put the work item ID in the subject: `agents: append the git standard (work-<domain>-<id>)`. Convention, not enforced.
- Without a work item, use a conventional prefix: `fix(scope):`, `chore(scope):`, `docs(scope):`. With the ID in the subject the prefix is optional.
- When you edit or delete a test, add a `test-change: <why>` line to the commit message (a hook will check it later).

## 4. Shared history
- Never rewrite history that is already merged.
- Never force-push a shared branch (`wolf/1uk4`, `stable`).
- Task branches merge into their feature branch automatically on task_done: wolfd rebases them and fast-forwards.
- A feature branch lands on the home branch (`wolf/<wolf>`, e.g. `wolf/1uk4`) through a PR, as a **merge commit**. No squash merge, no rebase merge: per-task commits and hashes are kept, and the feature can be reverted with `git revert -m 1`.
- `stable` changes only through a PR from the home branch. GitHub rejects direct pushes to `stable` (ruleset).
- The owner merges every PR. Agents open PRs, watch CI and report; they never run `gh pr merge` and never merge into `stable` or the home branch themselves.
- The release PR from the home branch into `stable` is also merged with a merge commit, never squashed. Flow: `docs/releases.md`.
- Release flow, release notes and the `fixes` branch: `docs/releases.md`.

## Before you report done
1. `git log --oneline <base>..HEAD` shows 1-2 commits.
2. Each commit is one behaviour (plus its tests, or a separate refactor/docs change).
3. No `fixup!`, `squash!` or WIP commits are left.
4. Every commit message names the work item, or uses a conventional prefix.
5. Any edited or deleted test is explained by a `test-change:` line.
