# Routine brief for fast-tier workers

Applies to the orchestrator when it spawns a worker with model `fast`, and to that worker.
Goal: a task so exact the fast tier can do it without judgment, and stops when it cannot.
The worker reads `packages/agents/standards/reading.md` first (how to read, search and verify with bounded output).

## 1. When to use it

Use it for a single obvious change, at most about 3 files named exactly, no design choices. Examples: a rename, a one-file edit, a config line, run-and-report.

Do NOT use it for:
- anything that needs judgment, or debugging, or an unknown cause;
- multi-step refactors;
- anything touching auth, security or data migration.

Reviewers stay on smart or stronger. Never spawn a reviewer on the fast tier.

## 2. Template

```
Work item: work-<domain>-<id>
Read first: packages/agents/standards/reading.md

Goal: <one sentence>

Files (exact, repo-relative; line ranges if known):
- path/to/file.ts:40-60

Change:
<exact before -> after, or a precise instruction>

Verify (exact commands, and what passing looks like):
- wolfpack test run <file>   -> all tests pass
- tsc --noEmit -p <pkg>      -> no output

Commit: `<scope>: <what> (work-<domain>-<id>)` (one commit, only the listed files)

Stop conditions. Stop and report; do not improvise if:
- the text to change is not where stated;
- verify fails after one straightforward fix attempt;
- the change needs a file that is not listed;
- anything is ambiguous.

Return: commit hash; the last lines of the verify output; anything unexpected.
```

## 3. Example

```
Work item: work-wolfpack-AbC1234
Read first: packages/agents/standards/reading.md

Goal: rename the config key `pollMs` to `pollIntervalMs` in the hub client.

Files:
- packages/hub/src/client.ts:12-30 (the only use)
- packages/hub/src/client.test.ts

Change: in both files replace the identifier `pollMs` with `pollIntervalMs`. No other edits.

Verify:
- wolfpack test run packages/hub/src/client.test.ts -> all pass
- tsc --noEmit -p packages/hub -> no output

Commit: `hub: rename pollMs to pollIntervalMs (work-wolfpack-AbC1234)`

Stop conditions: `pollMs` is used in any other file; verify fails after one fix attempt; anything unclear.

Return: commit hash, last 10 lines of verify output, anything unexpected.
```
