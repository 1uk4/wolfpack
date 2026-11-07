# Testing

The testing standard ships with Wolfpack: [`packages/agents/standards/testing.md`](../packages/agents/standards/testing.md). Edit it there, not here.

The agents loader always appends the `testing` standard to the profiles named `worker`, `planner` and `reviewer`, whichever directory they come from (shipped, wolf-level or project override), and never twice. An override does not need a `standards:` line for these. Other profiles opt in with `standards: <name>` in their frontmatter.

## The test runner (`wolfpack test`)
Agents run tests with `wolfpack test [run|related] [paths…] [-t <name>] [--no-cache]`, never vitest directly. `wolfpack` must be on PATH, and a version that has `test` (`wolfpack test --help` exits 0): otherwise nothing is rewritten. A direct `vitest`, `npx vitest`, `pnpm exec vitest`, `pnpm vitest` or `pnpm --filter @wolfpack/<pkg> test` in an agent shell is rewritten to it. A bare `pnpm test` / `npm test` is not (it runs the suite of the directory it is in), and the console's `tsx --test` suite is left alone. `wolfpack pr prepare` runs its vitest step through it too (with its own CLI, not `wolfpack` from PATH).
- **Queue:** one runner per host. Runs wait for a free slot and print their place in line. `tests.slots` (default 2) is how many runs go at once; `tests.workersPerRun` (default 2) is the vitest worker count of each. Set both under `tests:` in `~/.wolfpack/config.yaml`; `WOLFPACK_TEST_SLOTS` and `WOLFPACK_TEST_WORKERS` override them. The queue lives in `~/.wolfpack/run/test-queue/`. A crashed runner's leftover vitest is stopped by the next run's sweep.
- **Cache:** a passing run is stored in `~/.cache/wolfpack/test-results/` (14 days, 200 entries). The key covers the git state and uncommitted changes, the arguments, the lockfile, the built `packages/*/dist` the tests import, the node and vitest versions, the platform, a few env vars and the config files in `~/.wolfpack` (`config.yaml`, `domains.yaml`, `devices.yaml`, `.env`). A hit prints `PASS (cached …)`. Failures are never cached. `--no-cache` skips both reading and writing.
- **Never cached:** tests that read other files in the real home directory (the list is `HOME_CONFIG_TESTS` in `packages/cli/src/test-cache.ts`). A new test that reads the home directory belongs on that list.
- **Owner bypass:** only agent shells (`WOLFPACK_AGENT_RUN=1`, or a subagent) wait in the queue. Your own shell runs `wolfpack test` straight away, still using the cache. `WOLFPACK_TEST_BYPASS=1` gives an agent shell the same treatment and also stops the rewrite of direct vitest runs.
- **Exit codes:** 75 = waited 20 minutes in the queue without getting a slot (run it again); 124 = the run took longer than 20 minutes and was stopped. Otherwise vitest's own exit code.

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
