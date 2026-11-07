import { describe, expect, it } from "vitest";
import { makeSupportCheck, routeTestCommand } from "./command-guard.js";

const agent = { WOLFPACK_AGENT_RUN: "1" };
/** A `wolfpack` that supports `test` (the real PATH is never consulted in these tests). */
const supported = () => true;
const NOTE = /^echo '\[wolfpack\] test run routed through the test queue \(wolfpack test\)' >&2; /;
/** The command after the one-line note. */
const routed = (cmd: string, env: NodeJS.ProcessEnv = agent) => {
  const r = routeTestCommand(cmd, env, supported);
  expect(r.routed).toBe(true);
  expect(r.command).toMatch(NOTE);
  return r.command.replace(NOTE, "");
};
const untouched = (cmd: string, env: NodeJS.ProcessEnv = agent) => {
  const r = routeTestCommand(cmd, env, supported);
  expect(r).toEqual({ command: cmd, routed: false });
};

describe("routing direct test runs through the queue", () => {
  it.each([
    ["vitest run packages/cli/src/pm.test.ts", "wolfpack test run packages/cli/src/pm.test.ts"],
    ["npx vitest run a.test.ts b.test.ts", "wolfpack test run a.test.ts b.test.ts"],
    ["pnpm exec vitest run packages/cli/src/pm.test.ts", "wolfpack test run packages/cli/src/pm.test.ts"],
    ["pnpm vitest related src/x.ts --run", "wolfpack test related src/x.ts"],
    ["pnpm exec vitest run -t 'a name' x.test.ts", "wolfpack test run -t 'a name' x.test.ts"],
    ["./node_modules/.bin/vitest run x.test.ts", "wolfpack test run x.test.ts"],
    ["vitest run x.test.ts 2>&1", "wolfpack test run x.test.ts 2>&1"],
    ["pnpm --filter @wolfpack/cli test", "wolfpack test run packages/cli"],
    ["pnpm -F @wolfpack/harness test", "wolfpack test run packages/harness"],
    ["CI=1 pnpm exec vitest run x.test.ts", "CI=1 wolfpack test run x.test.ts"],
  ])("%s", (cmd, want) => {
    expect(routed(cmd)).toBe(want);
  });

  it("rewrites only the test segment of a compound command and leaves the rest as written", () => {
    expect(routed("cd packages/cli && pnpm exec vitest run x.test.ts")).toBe("cd packages/cli && wolfpack test run x.test.ts");
    expect(routed("pnpm exec vitest run x.test.ts | tail -20")).toBe("wolfpack test run x.test.ts | tail -20");
    expect(routed("git status; npx vitest run a.test.ts || echo 'failed: vitest run'")).toBe("git status; wolfpack test run a.test.ts || echo 'failed: vitest run'");
    expect(routed("pnpm exec vitest run a.test.ts && pnpm exec vitest run b.test.ts")).toBe("wolfpack test run a.test.ts && wolfpack test run b.test.ts");
  });

  it("prints one note, however many segments were routed", () => {
    const r = routeTestCommand("pnpm exec vitest run a.test.ts && npx vitest run b.test.ts", agent, supported);
    expect(r.command.match(/routed through the test queue/g)).toHaveLength(1);
  });
});

describe("leaving a command alone", () => {
  it("does nothing outside an agent shell, or when the bypass is set (env or inline)", () => {
    untouched("pnpm exec vitest run x.test.ts", {});
    untouched("pnpm exec vitest run x.test.ts", { WOLFPACK_AGENT_RUN: "0" });
    untouched("pnpm exec vitest run x.test.ts", { ...agent, WOLFPACK_TEST_BYPASS: "1" });
    untouched("WOLFPACK_TEST_BYPASS=1 pnpm exec vitest run x.test.ts");
  });

  it("does nothing for commands that are not a direct test run", () => {
    untouched("pnpm run build");
    untouched("pnpm install --frozen-lockfile");
    untouched("git log --oneline | grep vitest");
    untouched("echo vitest run");
    untouched("wolfpack test run x.test.ts");
    untouched("grep -rn 'pnpm test' docs");
    untouched("pnpm exec tsc --noEmit");
  });

  // A bare package script runs the suite of the directory it is run in (`cd packages/cli && pnpm test` is cli's, not the
  // repo's); `wolfpack test` with no arguments would run the whole repo. So every bare script form stays as written.
  it.each([
    ["pnpm test"],
    ["npm test"],
    ["npm run test"],
    ["cd packages/cli && pnpm test"],
    ["npm test -- x"],
    ["pnpm test -- run x.test.ts"],
    ["npm run test -- x.test.ts"],
  ])("bare script: %s", (cmd) => {
    untouched(cmd);
  });

  // When in doubt the command stays as written (the brief: never block, never guess). Each case says why.
  it.each([
    // the console's suite is `tsx --test` (bash scripts/test.sh), not vitest: the runner cannot run it
    ["pnpm --filter @wolfpack/console test"],
    // a package name that does not map to a directory by rule
    ["pnpm --filter some-other-pkg test"],
    // flags the runner does not accept: routing would turn a working command into a usage error
    ["pnpm exec vitest run x.test.ts --reporter=verbose"],
    ["pnpm exec vitest run --coverage"],
    // a different vitest subcommand, and a package script that is not the suite
    ["pnpm exec vitest watch"],
    ["pnpm exec vitest bench"],
    ["npm run test:e2e"],
    // shell structure the scanner does not take apart: substitution, subshell, heredoc, comment, unbalanced quote
    ["echo $(pnpm exec vitest run x.test.ts)"],
    ["(cd packages/cli && pnpm exec vitest run x.test.ts)"],
    ["`pnpm exec vitest run x.test.ts`"],
    ["cat <<EOF\nvitest run\nEOF"],
    ["pnpm exec vitest run x.test.ts # run it"],
    ["pnpm exec vitest run 'x.test.ts"],
    ["pnpm exec vitest run $FILE"],
  ])("%s", (cmd) => {
    untouched(cmd);
  });
});

describe("only when wolfpack can run `test`", () => {
  it("leaves the command unchanged, with no note, when the wolfpack on PATH does not support `test`", () => {
    const cmd = "pnpm exec vitest run x.test.ts";
    expect(routeTestCommand(cmd, agent, () => false)).toEqual({ command: cmd, routed: false });
  });

  it("asks only when there is something to route, and only once for a command with several test segments", () => {
    let asked = 0;
    const counting = () => (asked++, true);
    routeTestCommand("pnpm run build && git status", agent, counting);
    expect(asked).toBe(0);
    routeTestCommand("pnpm exec vitest run a.test.ts && pnpm exec vitest run b.test.ts", agent, counting);
    expect(asked).toBe(1);
  });
});

describe("a path-less vitest run after a cd", () => {
  // vitest started after `cd packages/cli` runs cli's tests; `wolfpack test run` with no path runs the repo's. So when an
  // earlier segment changes directory and the test segment names no path, the whole command stays as written.
  it.each([
    ["cd packages/cli && pnpm exec vitest run"],
    ["cd packages/cli && pnpm exec vitest run queue"],
    ["pushd packages/cli; npx vitest run -t 'a name'"],
    ["cd packages/cli && git status && pnpm exec vitest run --no-cache"],
    ["pnpm -C packages/cli test"],
    ["pnpm --dir packages/cli test"],
  ])("unchanged: %s", (cmd) => {
    untouched(cmd);
  });

  it("still routes when the test segment names a path, or when nothing changed directory first", () => {
    expect(routed("cd packages/cli && pnpm exec vitest run src/x.test.ts")).toBe("cd packages/cli && wolfpack test run src/x.test.ts");
    expect(routed("pnpm exec vitest run")).toBe("wolfpack test run");
    expect(routed("pnpm exec vitest run && cd packages/cli")).toBe("wolfpack test run && cd packages/cli");
  });
});

describe("the support check keeps only a definite answer", () => {
  const result = (r: { status?: number | null; error?: Error }) => ({ status: r.status ?? null, error: r.error });
  const errno = (code: string) => Object.assign(new Error(code), { code });
  const counted = (...rs: Array<ReturnType<typeof result>>) => {
    let calls = 0;
    const check = makeSupportCheck(() => rs[Math.min(calls++, rs.length - 1)] as never);
    return { check, calls: () => calls };
  };

  it("caches exit 0 as yes", () => {
    const c = counted(result({ status: 0 }));
    expect([c.check(), c.check(), c.check()]).toEqual([true, true, true]);
    expect(c.calls()).toBe(1);
  });

  it("caches a non-zero exit and ENOENT as no", () => {
    const a = counted(result({ status: 1 }));
    expect([a.check(), a.check()]).toEqual([false, false]);
    expect(a.calls()).toBe(1);
    const b = counted(result({ error: errno("ENOENT") }));
    expect([b.check(), b.check()]).toEqual([false, false]);
    expect(b.calls()).toBe(1);
  });

  it("does not cache a timeout or another spawn error: not supported for that call, asked again next time", () => {
    const c = counted(result({ error: errno("ETIMEDOUT") }), result({ error: errno("EAGAIN") }), result({ status: 0 }));
    expect(c.check()).toBe(false);
    expect(c.check()).toBe(false);
    expect(c.check()).toBe(true);
    expect(c.check()).toBe(true);
    expect(c.calls()).toBe(3);
  });
});
