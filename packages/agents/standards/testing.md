# Testing standard

Applies to every test in this repo, and above all to tests written by agents.
Goal: few tests, each of which fails when behaviour breaks and stays green when it doesn't.

## 1. Decide whether to test at all
- Test a change only when there is an independent source of truth to check it
  against: a spec, a worked example, a known-good literal, a contract another
  component depends on.
- Do NOT write tests for config, wiring, glue, type-only code, re-exports or
  straight pass-through/delegation. A test there can only restate the code.
  Cover it through the seam that uses it, or let the typecheck cover it.
- Deletion test: if deleting a module would make its complexity disappear, it is a
  pass-through and doesn't earn its own tests.

## 2. Test at agreed seams
- A seam is a public boundary where behaviour is observed without reaching inside:
  an exported function, an HTTP route, a CLI command, a rendered page.
- The plan lists the seams for the task. Each seam has one line: what it catches,
  and what it misses.
- Tests go only at listed seams. A new seam goes back to the planner or owner first.
- Never import internals or private helpers to test them. If you need to test past
  the interface, the module is the wrong shape: say so, don't work around it.
- Put each test at the lowest listed seam that can catch the bug. Don't repeat it
  at a higher layer.

## 3. Write tests that can fail
1. Expected values are literals or come from the spec or a worked example. Never
   compute them with the same logic or constants as the code under test.
2. Don't assert that a constant equals itself or that exported strings are what they are.
3. Mock only at system boundaries: network and external APIs, the clock, randomness,
   sometimes the filesystem. Prefer an in-memory stand-in or a real temp dir for
   things we own. Never mock our own modules.
4. Don't assert on a stub's return value that the same test configured.
5. Don't assert on incidental details: non-contract URLs and paths, call counts or
   order of internal calls, log text, CSS class names, private state, whole-object dumps.
6. Verify through the interface, not a side channel (read it back via the API, not
   by opening the file or database it wrote to).
7. A bare truthy check (`toBeTruthy`, `assert.ok(x)`) is not an assertion of
   behaviour. Assert the value that matters.

## 4. One test per behaviour, no duplicates
- One test per behaviour, named by the behaviour ("rejects an expired token"),
  not by the function. Several asserts are fine if they describe one behaviour.
- No parameterised copies that walk the same branch.
- Before adding a test, grep for existing tests of the behaviour (function, route,
  error text). Extend the existing test instead of adding a new file.
- Replace, don't layer: when a seam test covers a module, delete the older shallow
  tests that only re-prove it.

## 5. The loop
- Vertical slices: one test, watch it fail for the right reason, write just enough
  code to pass, then the next behaviour. No batch of tests written up front.
- A bug fix starts with a test that reproduces it and fails.
- Refactoring is not part of the loop; it happens at review.
- Browser, end-to-end and live tests come after the behaviour works at a seam.

## 6. Never game a test
- Never edit a test just to make it pass. When a test fails, decide which is wrong:
  the code or the test. Change a test only when the required behaviour changed, and
  say so in the commit message.
- Never skip, loosen (weaker matcher, deleted assert), special-case or delete a test
  to get green. Never add test detection to production code.
- No test is "known failing". A red test is fixed, or removed with owner approval,
  the same day.

## 7. Determinism, live tests, flakes
- Tests don't depend on real time, randomness, network or run order.
- Live tests (real wolf, Claude, network) carry the `live` gate and never run in the
  default suite. Slow evals carry the `eval` gate. Both run on the release PR.
- A flaky test is a bug: fix it, or quarantine it with an owner and a date. Don't
  add retries to hide it.

## Before you add a test
- [ ] Is there an independent source of truth? (If not, don't add it.)
- [ ] Which listed seam is it at?
- [ ] The behaviour it protects, in one sentence.
- [ ] grep done: no existing test covers it.
- [ ] Expected value independent of the implementation.
- [ ] Would it survive a refactor, a renamed file, a moved URL?
- [ ] Seen red.

## How to verify your work
1. While working, run single test files (`vitest related --run <files>`, or the
   package's own command). Run the affected suites once at the end, plus typecheck.
2. Red evidence: for each new test, show the failing run (test name and failure
   message) before the fix, then the green run. A test never seen red is a
   tautology candidate.
3. Check the real behaviour where tests can't: run the CLI, call the endpoint,
   load the page.
4. The final report lists the commands run with pass/fail counts, the red evidence,
   and every test changed or removed with the reason.
5. Say plainly what was NOT run (full suite, live, eval). CI runs those on the
   release PR into stable.

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
