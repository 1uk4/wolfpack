# Testing

The testing standard ships with Wolfpack: [`packages/agents/standards/testing.md`](../packages/agents/standards/testing.md). Edit it there, not here.

The agents loader always appends the `testing` standard to the profiles named `worker`, `planner` and `reviewer`, whichever directory they come from (shipped, wolf-level or project override), and never twice. An override does not need a `standards:` line for these. Other profiles opt in with `standards: <name>` in their frontmatter.

## The test runner (`wolfpack test`)
Agents run tests with `wolfpack test [run|related] [paths…] [-t <name>] [--no-cache]`, never vitest directly. `wolfpack` must be on PATH, and a version that has `test` (`wolfpack test --help` exits 0): otherwise nothing is rewritten. A direct `vitest`, `npx vitest`, `pnpm exec vitest`, `pnpm vitest` or `pnpm --filter @wolfpack/<pkg> test` in an agent shell is rewritten to it. A bare `pnpm test` / `npm test` is not (it runs the suite of the directory it is in). `pnpm --filter @wolfpack/console test` (and the npm workspace forms) is rewritten to `wolfpack test run apps/console`, which an agent run refuses (see below). A direct `tsx --test` / `npx tsx --test` and shell loops over `*.test.*` files are blocked for workers. `wolfpack pr prepare` runs its vitest step through it too (with its own CLI, not `wolfpack` from PATH).
- **Queue:** one runner per host. Runs wait for a free slot and print their place in line. `tests.slots` (default 2) is how many runs go at once; `tests.workersPerRun` (default 2) is the vitest worker count of each. Set both under `tests:` in `~/.wolfpack/config.yaml`; `WOLFPACK_TEST_SLOTS` and `WOLFPACK_TEST_WORKERS` override them. The queue lives in `~/.wolfpack/run/test-queue/`. A crashed runner's leftover vitest is stopped by the next run's sweep.
- **Cache:** a passing run is stored in `~/.cache/wolfpack/test-results/` (14 days, 200 entries). The key covers the git state and uncommitted changes, the arguments, the lockfile, the built `packages/*/dist` the tests import, the node and vitest versions, the platform, a few env vars and the config files in `~/.wolfpack` (`config.yaml`, `domains.yaml`, `devices.yaml`, `.env`). A hit prints `PASS (cached …)`. Failures are never cached. `--no-cache` skips both reading and writing.
- **Never cached:** tests that read other files in the real home directory (the list is `HOME_CONFIG_TESTS` in `packages/cli/src/test-cache.ts`). A new test that reads the home directory belongs on that list.
- **Owner bypass:** only agent shells (`WOLFPACK_AGENT_RUN=1`, or a subagent) wait in the queue. Your own shell runs `wolfpack test` straight away, still using the cache. `WOLFPACK_TEST_BYPASS=1` gives an agent shell the same treatment and also stops the rewrite of direct vitest runs.
- **Console tests:** paths under `apps/console/` run with the console's own `tsx --test` (resolved from `apps/console`, not PATH), in `apps/console` with `NODE_ENV=test`, through the same queue slots, cache, nice level and process group. Node's `--test-timeout=120000` limits each test file to 120 s: a file that hangs fails, and the runner prints its name. Agents run named files only (`wolfpack test run apps/console/tests/<file>`); a whole-suite run (`apps/console` alone, or `related` with only console paths) is refused with exit 2 because CI runs the whole suite. Console and package paths in one command are refused (exit 2); run them separately. Never loop over files and never call `tsx --test` directly. Without the CLI, `bash apps/console/scripts/test.sh [files]` does the same job.
- **Exit codes:** 75 = waited 20 minutes in the queue without getting a slot (run it again); 124 = the run took longer than 20 minutes and was stopped; 2 = refused (whole console suite for an agent, or console and package paths mixed). Otherwise the test runner's own exit code.

## Live and eval tests
One mechanism: vitest projects in the root `vitest.config.ts`.
- `default` collects everything except `*.live.test.*` and `*.eval.test.*`. `wolfpack test` always selects it, so a slow file named by path (or through `related`) is not run. `pnpm test` does too.
- `pnpm test:live` runs only `*.live.test.*` with `WOLFPACK_LIVE=1`: real Claude through the Claude Code login, so only on the owner's Mac. Today that is the one-turn subscription smoke test (`wolfd.subscription.live.test.ts`); without a login it fails with a message that says so.
- `pnpm test:eval` runs only `*.eval.test.*` (the KB tree-rules and llm-split evals, about a minute).
- Both run on the release PR only, never per task or per merge: `wolfpack pr prepare` runs `test:live` before opening the PR (`--skip-live` omits it and the PR body says so), and CI runs `test:eval` as its own `eval` job. Live tests never run in GitHub CI (no secrets there).
- A test that costs money or needs a login is never gated by a `skipIf` of its own: name it `.live.` or `.eval.`. `scripts/vitest-projects.test.ts` fails if the default selection ever collects one.

## Sources
- Google Testing Blog: Change-Detector Tests Considered Harmful (2015);
  Test Behavior, Not Implementation (2013); Don't Overuse Mocks (2013);
  Flaky Tests at Google (2016).
- Kent Beck, Test Desiderata.
- Martin Fowler, The Practical Test Pyramid ("Avoid Test Duplication").
- Kent C. Dodds, Write tests. Not too many. Mostly integration.
- Anthropic, Claude Code best practices (failing test first; evidence over "all tests pass").
- METR, Recent Frontier Models Are Reward Hacking (2025).
- Informed by mattpocock/skills (tdd, codebase-design), MIT.

House rules (ours, not cited): when not to test; seams listed in the plan and the
reviewer seam check; red evidence; no "known failing"; no retries for flakes.

The git commit standard lives in [`packages/agents/standards/git.md`](../packages/agents/standards/git.md). The loader always appends it to `worker` and `reviewer` (not the planner), after `testing`.

## CI by event
| Event | What `ci` runs |
|---|---|
| Push to a feature branch, PR into a non-`stable` branch | affected-only: tsc, `vitest --project default` on affected paths, console tests; tracer and release-smoke only when affected |
| PR into `stable`, push to `stable` (a "release") | the whole suite as if everything were affected, tracer and release-smoke always, and the `eval` job (`pnpm test:eval`) |

`pnpm test:live` runs only in `wolfpack pr prepare`, on the Mac.

## CI time budgets
Each `ci.yml` job's `timeout-minutes` is a budget, not a ceiling: ceil(2 x p95 of the job's wall time), floor 3. A job twice as slow as usual fails the run. `.github/ci-budgets.json` holds the numbers; `scripts/ci-workflow.test.ts` fails if a job's `timeout-minutes` differs from it or a job is missing.

Measured 2026-11-20 over 23 `ci.yml` runs since the verify split (created after 2026-11-20T22:00Z, includes pre-cache runs, so conservative). Only successful jobs count; vitest shards pool into one row. Command: `node scripts/ci-budgets.mjs --since 2026-11-20T22:00:00Z --limit 80`.

| job | n | p50 (min) | p95 (min) | max | budget (min) |
|---|---|---|---|---|---|
| detect | 23 | 0.3 | 0.3 | 0.4 | 5 (kept at 5; measured 3) |
| checks | 11 | 1.1 | 1.8 | 1.8 | 5 (measured 4; +1 for the console lint step, not in the samples) |
| release-smoke | 11 | 2.5 | 3.5 | 3.5 | 7 |
| console-tests | 9 | 3.7 | 4.7 | 4.7 | 10 |
| tracer | 15 | 3.5 | 4.0 | 4.0 | 8 |
| vitest | 23 | 3.0 | 4.4 | 4.6 | 9 |
| eval | 6 | 1.6 | 2.0 | 2.0 | 4 |
| ci | 19 | 0.1 | 0.1 | 0.1 | 5 (aggregate; small fixed value) |

Rerun the script after a change that legitimately slows a job, then update the JSON and the workflow together.

## What makes CI rerun everything
Affected-only selection (`scripts/affected.mjs`) marks every workspace when a change touches one of these inputs (`ROOT_CONFIG`, checked by `scripts/affected.test.ts`):
- `package-lock.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`
- root `package.json` and `tsconfig*.json`
- `vitest.config` / `vitest.setup` files, `turbo.json`
- `.github/workflows/**`
- `scripts/affected.*` (the selector itself)
- an unknown, zero or unreachable base commit

Docs (`*.md`, `docs/**`, `LICENSE`) mark nothing, except markdown under `packages/agents/{agents,standards,prompts}/` (agent profiles, standards and prompts), which is prompt input and marks `@wolfpack/agents` and its dependents.

A workspace that reaches another at runtime without importing it (it spawns a built `hubd.mjs`, runs `hubd pair`, mints hub tokens against it) must say so in its own `package.json`: `"ci": { "affectedBy": ["@wolfpack/hubd"] }`. `affected.mjs` treats those names like declared dependencies, so a change in them marks the consumer and its tests. `@wolfpack/cli` and `@wolfpack/desktop` do this today; the 4a88a410 owner-device gate on hubd slipped past an affected-only run because they did not.
