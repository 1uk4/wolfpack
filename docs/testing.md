# Testing

The testing standard ships with Wolfpack: [`packages/agents/standards/testing.md`](../packages/agents/standards/testing.md). Edit it there, not here.

The agents loader always appends the `testing` standard to the profiles named `worker`, `planner` and `reviewer`, whichever directory they come from (shipped, wolf-level or project override), and never twice. An override does not need a `standards:` line for these. Other profiles opt in with `standards: <name>` in their frontmatter.

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
