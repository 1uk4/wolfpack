import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script
import { GENERATED as RUNTIME_UPDATE_GENERATED } from "../../../scripts/runtime-update.mjs";
import { GENERATED_FILES, parsePrArgs, parseTotals, prPrepare, PrCommentsFailed, PrRefusal, type PrDeps, type PrPrepareOptions, type WorkItemInfo } from "./pr-prepare.js";

const F1 = "work-wolfpack-feat0001";
const F2 = "work-wolfpack-feat0002";
const T1 = "work-wolfpack-task0001";
const T2 = "work-wolfpack-task0002";
const NOTES = "## Release notes\nRisk: touches the deploy path\nManual checks:\n- open the console\n";
const ITEMS: Record<string, { item: WorkItemInfo; body: string | null }> = {
  [F1]: { item: { id: F1, kind: "feature", title: "Git standards" }, body: `# Doc\n\`\`\`mermaid\ngraph TD; A-->B\n\`\`\`\nfeature text\n\n${NOTES}` },
  [F2]: { item: { id: F2, kind: "feature", title: "Second feature" }, body: "second text" },
  [T1]: { item: { id: T1, kind: "task", title: "A task", partOf: F1 }, body: "task" },
  [T2]: { item: { id: T2, kind: "task", title: "Another task", partOf: F2 }, body: "task" },
  "work-wolfpack-cyc00001": { item: { id: "work-wolfpack-cyc00001", kind: "task", title: "loop a", partOf: "work-wolfpack-cyc00002" }, body: null },
  "work-wolfpack-cyc00002": { item: { id: "work-wolfpack-cyc00002", kind: "task", title: "loop b", partOf: "work-wolfpack-cyc00001" }, body: null },
};

interface Over {
  branch?: string;
  dirty?: string;
  ghAuth?: number;
  ancestor?: number;
  merge?: number;
  /** Whether MERGE_HEAD exists after a failed merge (a real conflict). Default true. */
  mergeHead?: boolean;
  abort?: number;
  log?: string;
  prList?: { code: number; out: string };
  verifyOk?: boolean;
  verifyThrows?: boolean;
  remote?: string;
  lsFiles?: Record<string, string[]>;
  workThrows?: string[];
  /** false = WORK_ENDPOINT / WORK_TOKEN missing. Default true. */
  workConfigured?: boolean;
  /** Result of `gh pr create` / `gh pr edit`. */
  ghWrite?: { code: number; out: string; err: string };
  /** Replacement markdown for the feature documents (the Release notes are kept on the first). */
  f1Doc?: string;
  f2Doc?: string;
  /** Comments already on the PR. */
  existingComments?: { id: number | string; body: string; login?: string }[];
  /** The repo the existing PR lives in, as its URL names it (default: the origin's). */
  prRepo?: string;
  /** The URL `gh pr create` prints. */
  createUrl?: string;
  /** The authenticated user's login (`gh api user`). Default "wolfbot". */
  me?: string;
  /** Make the comment writes (`gh api -X POST|PATCH|DELETE`) fail. */
  commentFail?: boolean;
}

/** Fakes for git/gh/work/build. `git` answers by command; anything not listed succeeds with empty output. */
function fakes(over: Over = {}) {
  const gitCalls: string[][] = [];
  const ghCalls: { args: string[]; input?: string }[] = [];
  const workCalls: string[] = [];
  const out: string[] = [];
  const calls: string[] = [];
  const apiWrites: { method: string; path: string; input?: string }[] = [];
  let verifyCalls = 0;
  const ok = (o = "") => ({ code: 0, out: o, err: "" });
  const deps: PrDeps = {
    git(args) {
      gitCalls.push(args);
      calls.push(`git ${args.join(" ")}`);
      const key = args.join(" ");
      if (key === "rev-parse --abbrev-ref HEAD") return ok(over.branch ?? "wolf/1uk4");
      if (key === "status --porcelain") return ok(over.dirty ?? "");
      if (key === "merge-base --is-ancestor origin/stable HEAD") return { code: over.ancestor ?? 0, out: "", err: over.ancestor && over.ancestor > 1 ? "fatal: Not a valid commit name origin/stable" : "" };
      if (key === "merge --no-edit origin/stable") return { code: over.merge ?? 0, out: "", err: "CONFLICT (content): Merge conflict in a.ts" };
      if (key === "rev-parse -q --verify MERGE_HEAD") return { code: over.mergeHead === false ? 1 : 0, out: "", err: "" };
      if (key === "merge --abort") return { code: over.abort ?? 0, out: "", err: "fatal: abort exploded" };
      if (key === "rev-parse origin/stable") return ok("stable111");
      if (key === "rev-parse HEAD") return ok("headsha99");
      if (args[0] === "log") return ok(over.log ?? `aaa1111\tagents: git standard (${T1})\nbbb2222\tchore(deps): bump`);
      if (key === "remote get-url origin") return ok(over.remote ?? "git@github.com:1uk4/wolfpack.git");
      if (args[0] === "ls-files") {
        const dir = args[args.length - 1]!;
        return ok((over.lsFiles?.[dir] ?? []).map((f) => `${f}\0`).join(""));
      }
      return ok();
    },
    gh(args, input) {
      ghCalls.push({ args, input });
      calls.push(`gh ${args.join(" ")}`);
      if (args[0] === "api") {
        const method = args.includes("-X") ? args[args.indexOf("-X") + 1]! : "GET";
        const path = args.find((a) => a.startsWith("repos/"))!;
        if (args[1] === "user") return ok(`${over.me ?? "wolfbot"}\n`);
        if (method === "GET") {
          // What gh prints for the two jq filters this code has used: one JSON array per comment, or tab-separated.
          const jq = args[args.indexOf("--jq") + 1] ?? "";
          const all = (over.existingComments ?? []).map((c) => ({ ...c, login: c.login ?? over.me ?? "wolfbot" }));
          if (jq.includes("@json")) return ok(all.map((c) => JSON.stringify([c.id, c.login, c.body.slice(0, 64)])).join("\n"));
          return ok(all.map((c) => `${c.id}\t${c.body.slice(0, 64).replace(/\n/g, "\\n")}`).join("\n"));
        }
        apiWrites.push({ method, path, input });
        return over.commentFail ? { code: 1, out: "", err: "HTTP 500: server error" } : ok();
      }
      if (args[0] === "auth") return { code: over.ghAuth ?? 0, out: "", err: "" };
      if (args[0] === "pr" && args[1] === "list") {
        // The lookup asks for the PR's URL; a bare number in a test stands for "PR <n> in prRepo".
        const l = over.prList ?? { code: 0, out: "" };
        const n = /^(\d+)\s*$/.exec(l.out)?.[1];
        return { ...l, out: n ? `https://github.com/${over.prRepo ?? "1uk4/wolfpack"}/pull/${n}\n` : l.out, err: "" };
      }
      return over.ghWrite ?? ok(`Creating pull request...\n${over.createUrl ?? "https://github.com/1uk4/wolfpack/pull/9"}`);
    },
    workConfigured: () => over.workConfigured ?? true,
    async verify() {
      verifyCalls++;
      if (over.verifyThrows) throw new Error("spawn npx ENOENT");
      return { ok: over.verifyOk ?? true, summary: "build ok, typecheck ok, 312 tests passed" };
    },
    async work(id) {
      workCalls.push(id);
      if (over.workThrows?.includes(id)) throw new Error("connect ECONNREFUSED");
      const base = ITEMS[id];
      if (base && id === F1 && over.f1Doc) return { ...base, body: `${over.f1Doc}\n\n${NOTES}` };
      if (base && id === F2 && over.f2Doc) return { ...base, body: over.f2Doc };
      return base ?? null;
    },
    now: () => new Date("2026-11-06T10:00:00Z"),
    log: (l) => out.push(l),
  };
  return { deps, gitCalls, ghCalls, workCalls, out, calls, apiWrites, verifyCalls: () => verifyCalls };
}
type Fakes = ReturnType<typeof fakes>;
const run = (o: PrPrepareOptions, f: Fakes) => prPrepare(o, f.deps);
const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as Error);
const cmds = (f: Fakes) => [...f.gitCalls.map((a) => `git ${a.join(" ")}`), ...f.ghCalls.map((c) => `gh ${c.args.join(" ")}`)];
const writes = (f: Fakes) => cmds(f).filter((c) => /^git push|^gh pr (create|edit|merge)|^gh api -X (POST|PATCH|DELETE)/.test(c));
/** About `kb` kilobytes of numbered lines. */
const rows = (kb: number) => Array.from({ length: Math.ceil((kb * 1000) / 8) }, (_, k) => `row ${k}`).join("\n");
const marked = (n: number, text = "old") => `<!-- wolfpack-release-part:${n} -->\n${text}`;
const body = (f: Fakes) => f.ghCalls.find((g) => g.args[1] === "create" || g.args[1] === "edit")!.input!;

describe("wolfpack pr prepare: refusals", () => {
  it.each([
    ["the tree is dirty", { dirty: " M a.ts" }, {}, /dirty/],
    ["the branch is not wolf/<wolf>", { branch: "feat/x" }, {}, /wolf\/<wolf>/],
    ["gh is not authenticated", { ghAuth: 1 }, {}, /not authenticated/],
    ["a base other than stable is asked for", {}, { base: "wolf/1uk4" }, /stable only/],
    ["there is nothing beyond origin/stable", { log: "" }, {}, /nothing to release/],
    ["build or tests fail", { verifyOk: false }, {}, /tests failed/],
  ] as [string, Over, PrPrepareOptions, RegExp][])("refuses, pushing and opening nothing, when %s", async (_n, over, opts, msg) => {
    const f = fakes(over);
    const err = await failure(run(opts, f));
    expect(err).toBeInstanceOf(PrRefusal);
    expect(err!.message).toMatch(msg);
    expect(writes(f)).toEqual([]);
  });

  it("refuses, before fetching or merging anything, when the Work API is not configured", async () => {
    const f = fakes({ workConfigured: false, ancestor: 1 });
    const err = await failure(run({}, f));
    expect(err).toBeInstanceOf(PrRefusal);
    expect(err!.message).toMatch(/Work API not configured/);
    expect(cmds(f).filter((c) => /^git (fetch|merge |push)/.test(c))).toEqual([]);
    expect(writes(f)).toEqual([]);
  });

  it("checks gh auth for github.com specifically", async () => {
    const f = fakes();
    await run({}, f);
    expect(f.ghCalls[0]!.args).toEqual(["auth", "status", "--hostname", "github.com"]);
  });

  it("refuses with git's message when the ancestor check fails for a reason other than 'not an ancestor'", async () => {
    const f = fakes({ ancestor: 128 });
    const err = await failure(run({}, f));
    expect(err).toBeInstanceOf(PrRefusal);
    expect(err!.message).toContain("fatal: Not a valid commit name origin/stable");
    expect(cmds(f)).not.toContain("git merge --no-edit origin/stable");
    expect(writes(f)).toEqual([]);
  });

  it("does not count the console's generated next-env.d.ts as a dirty tree, but still refuses for any other change", async () => {
    const gen = fakes({ dirty: " M apps/console/next-env.d.ts\n" });
    await run({}, gen);
    expect(writes(gen).some((w) => w.startsWith("git push"))).toBe(true);
    for (const dirty of [" M apps/console/next-env.d.ts\n M a.ts\n", "?? scratch.txt\n", "M  staged.ts\n"]) {
      const f = fakes({ dirty });
      const err = await failure(run({}, f));
      expect(err, dirty).toBeInstanceOf(PrRefusal);
      expect(err!.message).toMatch(/dirty/);
      expect(writes(f)).toEqual([]);
    }
  });

  it("ignores the same generated files as scripts/runtime-update.mjs", () => {
    expect([...GENERATED_FILES]).toEqual([...RUNTIME_UPDATE_GENERATED]);
  });

  it("refuses before any push when the existing-PR lookup fails or returns something that is not a PR number", async () => {
    // A failed command is refused even if it printed a number; a successful one is refused if it printed anything else.
    for (const prList of [{ code: 1, out: "7" }, { code: 0, out: "oops, not a number" }]) {
      const f = fakes({ prList });
      const err = await failure(run({}, f));
      expect(err).toBeInstanceOf(PrRefusal);
      expect(err!.message).toMatch(/existing pull request/);
      expect(writes(f)).toEqual([]);
    }
  });

  it("treats an empty or null lookup as no open PR, and updates the PR when it prints a number", async () => {
    for (const out of ["", "null\n"]) {
      const f = fakes({ prList: { code: 0, out } });
      await run({}, f);
      expect(f.ghCalls.some((g) => g.args[1] === "create")).toBe(true);
    }
    const f = fakes({ prList: { code: 0, out: "7\n" } });
    await run({}, f);
    expect(f.ghCalls.some((g) => g.args[1] === "edit" && g.args[2] === "7")).toBe(true);
    expect(f.ghCalls.some((g) => g.args[1] === "create")).toBe(false);
  });
});

describe("wolfpack pr prepare: syncing stable", () => {
  it("fetches stable with an explicit refspec and merges origin/stable when it is not an ancestor, as a merge and not a rebase", async () => {
    const f = fakes({ ancestor: 1 });
    await run({}, f);
    expect(cmds(f)).toContain("git fetch origin +refs/heads/stable:refs/remotes/origin/stable");
    expect(cmds(f)).toContain("git merge --no-edit origin/stable");
    expect(cmds(f).some((c) => c.includes("rebase"))).toBe(false);
  });

  it("aborts the merge on a real conflict and stops without pushing, showing git's message", async () => {
    const f = fakes({ ancestor: 1, merge: 1 });
    const err = await failure(run({}, f));
    expect(err).toBeInstanceOf(PrRefusal);
    expect(err!.message).toMatch(/conflicts; the merge was aborted/);
    expect(err!.message).toContain("CONFLICT (content): Merge conflict in a.ts");
    expect(cmds(f)).toContain("git merge --abort");
    expect(writes(f)).toEqual([]);
  });

  it("says the repo is mid-merge, and how to recover, when the abort itself fails", async () => {
    const f = fakes({ ancestor: 1, merge: 1, abort: 1 });
    const err = await failure(run({}, f));
    expect(err).toBeInstanceOf(PrRefusal);
    expect(err!.message).toMatch(/mid-merge/);
    expect(err!.message).toContain("git merge --abort");
    expect(err!.message).toContain("fatal: abort exploded");
    expect(writes(f)).toEqual([]);
  });

  it("does not run an abort for a merge that failed without a conflict, and shows git's message", async () => {
    const f = fakes({ ancestor: 1, merge: 1, mergeHead: false });
    const err = await failure(run({}, f));
    expect(err).toBeInstanceOf(PrRefusal);
    expect(err!.message).toMatch(/not a conflict/);
    expect(err!.message).toContain("CONFLICT (content)");
    expect(cmds(f)).not.toContain("git merge --abort");
    expect(writes(f)).toEqual([]);
  });

  it("says the branch was pushed, and to run prepare again, when opening the PR fails after the push", async () => {
    const f = fakes({ ghWrite: { code: 1, out: "", err: "HTTP 422: Validation Failed" } });
    const err = await failure(run({}, f));
    expect(err).toBeInstanceOf(PrRefusal);
    expect(err!.message).toContain("HTTP 422: Validation Failed");
    expect(err!.message).toMatch(/wolf\/1uk4 was pushed, but opening the pull request failed\. Run prepare again\./);
    expect(cmds(f)).toContain("git push origin refs/heads/wolf/1uk4:refs/heads/wolf/1uk4");
  });

  it("leaves the sync merge local and unpushed when a later step refuses, and says so", async () => {
    const f = fakes({ ancestor: 1, verifyOk: false });
    const err = await failure(run({}, f));
    expect(err).toBeInstanceOf(PrRefusal);
    expect(err!.message).toMatch(/tests failed/);
    expect(err!.message).toMatch(/origin\/stable was merged into wolf\/1uk4 locally; nothing was pushed/);
    expect(writes(f)).toEqual([]);
  });

  it("turns an unexpected crash in the build step into a clean refusal, not a stack trace", async () => {
    const f = fakes({ ancestor: 1, verifyThrows: true });
    const err = await failure(run({}, f));
    expect(err).toBeInstanceOf(PrRefusal);
    expect(err!.message).toContain("spawn npx ENOENT");
    expect(err!.message).toMatch(/nothing was pushed/);
    expect(f.out.some((l) => l.includes("Error: spawn npx ENOENT") && l.includes("\n    at "))).toBe(true);
    expect(writes(f)).toEqual([]);
  });
});

describe("wolfpack pr prepare: opening the PR", () => {
  it("pushes only the wolf branch, opens the PR into stable with the built body, and never merges or force-pushes", async () => {
    const f = fakes();
    await run({}, f);
    const c = cmds(f);
    expect(c.filter((x) => x.startsWith("git push"))).toEqual(["git push origin refs/heads/wolf/1uk4:refs/heads/wolf/1uk4"]);
    const create = f.ghCalls.find((g) => g.args[1] === "create")!;
    expect(create.args).toEqual(["pr", "create", "--base", "stable", "--head", "wolf/1uk4", "--title", "Release 1uk4 2026-11-06: 1 feature", "--body-file", "-"]);
    expect(create.input).toContain("### Git standards (work-wolfpack-feat0001)");
    expect(create.input).toContain("```mermaid\ngraph TD; A-->B\n```");
    expect(create.input).toContain("- bbb2222 chore(deps): bump");
    expect(create.input).toContain("312 tests passed");
    expect(create.input).toContain("- CI: see the checks on this PR");
    expect(create.input).toContain("- live/eval: not wired yet (work-wolfpack-tJ18SgU)");
    expect(c.filter((x) => /^gh pr merge|--force|--force-with-lease| -f /.test(x))).toEqual([]);
    expect(c.filter((x) => x.startsWith("gh api"))).toEqual([]);
    expect(c.filter((x) => x.startsWith("git push") && x.includes("stable"))).toEqual([]);
  });

  it("collects risk and manual checks from each feature's Release notes into the Decide header, labelled by feature", async () => {
    const f = fakes({ log: `aaa1111\tone (${T1})\nbbb2222\ttwo (${T2})` });
    await run({}, f);
    const b = body(f);
    expect(b).toContain("  - Git standards (work-wolfpack-feat0001): touches the deploy path");
    expect(b).toContain("  - Second feature (work-wolfpack-feat0002): _not provided_");
    expect(b).toContain("  - Git standards (work-wolfpack-feat0001):\n    - open the console");
  });

  it("lists a commit tagged with tasks of two features under both, and not under Other commits", async () => {
    const f = fakes({ log: `aaa1111\tboth (${T1}) (${T2})` });
    await run({}, f);
    const b = body(f);
    expect(f.ghCalls.find((g) => g.args[1] === "create")!.args).toContain("Release 1uk4 2026-11-06: 2 features");
    expect(b).toContain("### Git standards (work-wolfpack-feat0001)");
    expect(b).toContain("### Second feature (work-wolfpack-feat0002)");
    expect(b).toContain("## Other commits\nnone");
  });

  it("looks each work item up once, however many commits mention it", async () => {
    const f = fakes({ log: `aaa1111\tone (${T1})\nbbb2222\ttwo (${T1})\nccc3333\tthree (${T1})` });
    await run({}, f);
    expect(f.workCalls.filter((id) => id === T1)).toHaveLength(1);
  });

  it("puts commits whose work item is missing, unreachable or in a cycle under Other commits, warning with the ID", async () => {
    const gone = "work-wolfpack-gone0001";
    const down = "work-wolfpack-down0001";
    const cyc = "work-wolfpack-cyc00001";
    const f = fakes({ log: `aaa1111\tmissing (${gone})\nbbb2222\tdown (${down})\nccc3333\tloop (${cyc})\nddd4444\tgood (${T1})`, workThrows: [down] });
    await run({}, f);
    const b = body(f);
    expect(b).toContain("## Other commits\n- aaa1111 missing (work-wolfpack-gone0001)\n- bbb2222 down (work-wolfpack-down0001)\n- ccc3333 loop (work-wolfpack-cyc00001)");
    expect(b).not.toContain("- ddd4444");
    // Only the unreachable item is called unreadable; an unknown one (404) and a loop are not.
    expect(b).toContain("- ⚠ 1 work item could not be read: work-wolfpack-down0001; their commits are under Other commits");
    const warned = f.out.filter((l) => l.startsWith("warning"));
    expect(warned.some((l) => l.includes(gone))).toBe(true);
    expect(warned.some((l) => l.includes(down))).toBe(true);
  });

  it("opens the PR even when thousands of work items are unreadable: the IDs go to the first comment, so size cannot stop prepare", async () => {
    const ids = Array.from({ length: 3500 }, (_, k) => `work-wolfpack-dwn${String(k).padStart(5, "0")}`);
    const f = fakes({ log: ids.map((id, k) => `c${k}\tcommit (${id})`).join("\n"), workThrows: ids });
    await run({}, f);
    expect(body(f)).toContain("- ⚠ 3500 work items could not be read; IDs in the first comment");
    expect(writes(f).some((w) => w.startsWith("gh pr create"))).toBe(true);
    const posted = f.apiWrites.map((w) => (JSON.parse(w.input!) as { body: string }).body);
    expect(posted[0]).toContain("<!-- wolfpack-release-part:1 -->");
    expect(posted.join("\n")).toContain("work-wolfpack-dwn03499");
    for (const t of [body(f), ...posted]) expect(Buffer.byteLength(t, "utf8")).toBeLessThanOrEqual(65_536);
  });

  it("reports commits with no work item ID and lists them under Other commits", async () => {
    const f = fakes({ log: "ccc3333\tno id here" });
    await run({}, f);
    expect(f.out.join("\n")).toContain("warning: commit without a work item ID: ccc3333 no id here");
    expect(body(f)).toContain("- ccc3333 no id here");
  });

  it("links screenshots at the pushed commit, with each path segment URL-encoded, only for tracked image files", async () => {
    const dir = `docs/pr-assets/${F1}/`;
    const f = fakes({ lsFiles: { [dir]: [`${dir}after shot.png`, `${dir}notes.txt`] } });
    await run({}, f);
    expect(body(f)).toContain(`![${F1} screenshot](https://github.com/1uk4/wolfpack/blob/headsha99/docs/pr-assets/${F1}/after%20shot.png?raw=true)`);
    expect(body(f)).not.toContain("notes.txt");
  });

  it("keeps a dot in the repo name when linking screenshots", async () => {
    const dir = `docs/pr-assets/${F1}/`;
    const f = fakes({ remote: "git@github.com:1uk4/foo.js.git", lsFiles: { [dir]: [`${dir}a.png`] } });
    await run({}, f);
    expect(body(f)).toContain("https://github.com/1uk4/foo.js/blob/headsha99/");
  });

  it("says screenshot links are unavailable, instead of linking a relative path, when the remote is not GitHub", async () => {
    const dir = `docs/pr-assets/${F1}/`;
    const f = fakes({ remote: "ssh://git.example.com/x/y.git", lsFiles: { [dir]: [`${dir}a.png`] } });
    await run({}, f);
    expect(body(f)).toContain("Screenshots: link unavailable (no GitHub remote)");
    expect(body(f)).not.toContain("a.png");
  });
});

describe("wolfpack pr prepare: overflow comments", () => {
  const BOTH = `aaa1111\tone (${T1})\nbbb2222\ttwo (${T2})`;
  const COMMENTS = "repos/1uk4/wolfpack/issues/9/comments";

  it("posts what does not fit in the body as marked comments, after the PR is created, and lists them at the end of the body", async () => {
    const f = fakes({ log: BOTH, f1Doc: rows(40), f2Doc: rows(40) });
    await run({}, f);
    expect(body(f).trimEnd().endsWith("Continued in comments: Second feature")).toBe(true);
    expect(f.apiWrites).toHaveLength(1);
    expect(f.apiWrites[0]).toMatchObject({ method: "POST", path: COMMENTS });
    const posted = JSON.parse(f.apiWrites[0]!.input!) as { body: string };
    expect(posted.body.startsWith("<!-- wolfpack-release-part:1 -->\n### Second feature (work-wolfpack-feat0002)")).toBe(true);
    expect(posted.body).toContain(rows(40));
    expect(f.calls.findIndex((c) => c.startsWith("gh pr create"))).toBeLessThan(f.calls.findIndex((c) => c.startsWith("gh api -X POST")));
  });

  it("on a re-run edits its own comments in place, deletes leftovers, and never touches comments without the marker", async () => {
    const f = fakes({
      log: BOTH,
      f1Doc: rows(40),
      f2Doc: rows(40),
      prList: { code: 0, out: "7" },
      existingComments: [
        { id: 101, body: marked(1) },
        { id: 102, body: marked(2) },
        { id: 103, body: marked(3) },
        { id: 104, body: "a human comment" },
        { id: 105, body: "quoting <!-- wolfpack-release-part:1 --> mid-text" },
      ],
    });
    await run({}, f);
    expect(f.apiWrites.map((w) => `${w.method} ${w.path}`)).toEqual([
      "PATCH repos/1uk4/wolfpack/issues/comments/101",
      "DELETE repos/1uk4/wolfpack/issues/comments/102",
      "DELETE repos/1uk4/wolfpack/issues/comments/103",
    ]);
    expect((JSON.parse(f.apiWrites[0]!.input!) as { body: string }).body).toContain("### Second feature");
    expect(f.calls.some((c) => c.startsWith("gh pr edit 7"))).toBe(true);
  });

  it("adds the comments a longer overflow needs, editing the one it already has", async () => {
    const f = fakes({ f1Doc: rows(150), existingComments: [{ id: 101, body: marked(1) }], prList: { code: 0, out: "9" } });
    await run({}, f);
    expect(f.apiWrites.map((w) => `${w.method} ${w.path.replace("repos/1uk4/wolfpack/issues/", "")}`)).toEqual(["PATCH comments/101", "POST 9/comments", "POST 9/comments"]);
    const markers = f.apiWrites.map((w) => /^<!-- wolfpack-release-part:(\d+) -->/.exec((JSON.parse(w.input!) as { body: string }).body)?.[1]);
    expect(markers).toEqual(["1", "2", "3"]);
  });

  it("removes comments left from an earlier run when everything now fits in the body", async () => {
    const f = fakes({ prList: { code: 0, out: "7" }, existingComments: [{ id: 101, body: marked(1) }, { id: 104, body: "human" }] });
    await run({}, f);
    expect(f.apiWrites.map((w) => `${w.method} ${w.path}`)).toEqual(["DELETE repos/1uk4/wolfpack/issues/comments/101"]);
  });


  it("never edits or deletes a comment written by someone else, even one that starts with the marker", async () => {
    const f = fakes({
      f1Doc: rows(40),
      f2Doc: rows(40),
      log: `aaa1111\tone (${T1})\nbbb2222\ttwo (${T2})`,
      prList: { code: 0, out: "7" },
      existingComments: [
        { id: 101, body: marked(1) },
        { id: 104, body: marked(1, "pasted by a human"), login: "someone-else" },
        { id: 105, body: marked(9, "a human's stale part"), login: "someone-else" },
        { id: 106, body: marked(1, "from a bot"), login: "dependabot[bot]" },
      ],
    });
    await run({}, f);
    expect(f.apiWrites.map((w) => `${w.method} ${w.path}`)).toEqual(["PATCH repos/1uk4/wolfpack/issues/comments/101"]);
  });

  it("lists the PR's comments with --paginate, so a long thread cannot hide its own comments", async () => {
    const f = fakes({ f1Doc: rows(40), f2Doc: rows(40), log: `aaa1111\tone (${T1})\nbbb2222\ttwo (${T2})`, prList: { code: 0, out: "7" } });
    await run({}, f);
    const listing = f.ghCalls.find((g) => g.args[0] === "api" && g.args.some((a) => a.endsWith("/issues/7/comments")) && !g.args.includes("-X"))!;
    expect(listing.args).toContain("--paginate");
    expect(listing.args.join(" ")).not.toContain("wolfbot");
  });

  it("refuses to touch comments, saying the PR is open and to re-run, when the login is not a valid GitHub login", async () => {
    const f = fakes({ f1Doc: rows(40), f2Doc: rows(40), log: `aaa1111\tone (${T1})\nbbb2222\ttwo (${T2})`, me: 'x"; rm -rf ~' });
    const err = await failure(run({}, f));
    expect(err).toBeInstanceOf(PrCommentsFailed);
    expect(err!.message).toMatch(/opened\/updated; overflow comments failed: .*login/);
    expect(f.apiWrites).toEqual([]);
  });

  it("ignores a comment whose id is not a plain number, so it never reaches a path", async () => {
    const f = fakes({
      f1Doc: rows(40),
      f2Doc: rows(40),
      log: `aaa1111\tone (${T1})\nbbb2222\ttwo (${T2})`,
      prList: { code: 0, out: "7" },
      existingComments: [{ id: "12/../../x", body: marked(5) }, { id: 101, body: marked(1) }],
    });
    await run({}, f);
    expect(f.apiWrites.map((w) => `${w.method} ${w.path}`)).toEqual(["PATCH repos/1uk4/wolfpack/issues/comments/101"]);
  });

  it("keeps the lowest id and deletes the rest when several of its comments carry the same part number", async () => {
    const f = fakes({
      f1Doc: rows(40),
      f2Doc: rows(40),
      log: `aaa1111\tone (${T1})\nbbb2222\ttwo (${T2})`,
      prList: { code: 0, out: "7" },
      existingComments: [{ id: 205, body: marked(1) }, { id: 101, body: marked(1) }, { id: 150, body: marked(1) }],
    });
    await run({}, f);
    expect(f.apiWrites.map((w) => `${w.method} ${w.path}`)).toEqual([
      "PATCH repos/1uk4/wolfpack/issues/comments/101",
      "DELETE repos/1uk4/wolfpack/issues/comments/150",
      "DELETE repos/1uk4/wolfpack/issues/comments/205",
    ]);
  });
  it("uses the repo named in the PR's own URL for every comment call, not the origin remote's or gh's {owner}/{repo} default", async () => {
    const f = fakes({
      f1Doc: rows(40),
      f2Doc: rows(40),
      log: `aaa1111\tone (${T1})\nbbb2222\ttwo (${T2})`,
      prList: { code: 0, out: "7" },
      prRepo: "acme/other-repo.js",
      existingComments: [{ id: 101, body: marked(1) }, { id: 102, body: marked(2) }],
    });
    await run({}, f);
    expect(f.apiWrites.map((w) => `${w.method} ${w.path}`)).toEqual(["PATCH repos/acme/other-repo.js/issues/comments/101", "DELETE repos/acme/other-repo.js/issues/comments/102"].slice(0, f.apiWrites.length));
    const apiPaths = f.ghCalls.filter((g) => g.args[0] === "api").flatMap((g) => g.args.filter((a) => a.startsWith("repos/")));
    expect(apiPaths.length).toBeGreaterThan(0);
    for (const path of apiPaths) expect(path.startsWith("repos/acme/other-repo.js/")).toBe(true);
  });

  it("takes the repo from the URL gh pr create prints when it opens the PR", async () => {
    const f = fakes({ f1Doc: rows(150), createUrl: "https://github.com/acme/other/pull/31" });
    await run({}, f);
    const paths = f.apiWrites.map((w) => w.path);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path).toBe("repos/acme/other/issues/31/comments");
  });

  it("says the PR was opened and to re-run when the URL gh prints does not name a GitHub repo", async () => {
    const f = fakes({ f1Doc: rows(150), createUrl: "https://example.com/not/a/pull/request" });
    const err = await failure(run({}, f));
    expect(err).toBeInstanceOf(PrCommentsFailed);
    expect(err!.message).toContain("overflow comments failed");
    expect(f.apiWrites).toEqual([]);
  });

  it("links screenshots in the existing PR's repo, the same one the comments go to", async () => {
    const dir = `docs/pr-assets/${F1}/`;
    const f = fakes({ prList: { code: 0, out: "7" }, prRepo: "acme/other", lsFiles: { [dir]: [`${dir}a.png`] } });
    await run({}, f);
    expect(body(f)).toContain("https://github.com/acme/other/blob/headsha99/");
  });

  it("says the PR was opened and to re-run, when the comments fail after the PR exists", async () => {
    const f = fakes({ log: BOTH, f1Doc: rows(40), f2Doc: rows(40), commentFail: true });
    const err = await failure(run({}, f));
    expect(err).toBeInstanceOf(PrCommentsFailed);
    expect(err!.message).toBe("PR https://github.com/1uk4/wolfpack/pull/9 opened/updated; overflow comments failed: gh api failed: HTTP 500: server error; re-run prepare");
  });

  it("dry run counts the comments it would create, edit and delete, with their sizes, and writes nothing", async () => {
    const f = fakes({ log: BOTH, f1Doc: rows(40), f2Doc: rows(40), prList: { code: 0, out: "7" }, existingComments: [{ id: 101, body: marked(1) }, { id: 102, body: marked(2) }] });
    await run({ dryRun: true }, f);
    const text = f.out.join("\n");
    expect(text).toContain("overflow comments: would create 0, edit 1, delete 1");
    expect(text).toMatch(/comment 1: \d+ bytes/);
    expect(text).toMatch(/body: \d+ bytes/);
    expect(f.apiWrites).toEqual([]);
    expect(writes(f)).toEqual([]);
  });
});

describe("wolfpack pr prepare: dry run", () => {
  it("prints the body and the commands and changes nothing: no fetch, merge, build, push or gh write", async () => {
    const f = fakes({ ancestor: 1 });
    await run({ dryRun: true }, f);
    const text = f.out.join("\n");
    expect(text).toContain("# Release 1uk4 2026-11-06: 1 feature");
    expect(text).toContain("would run\n  git push origin refs/heads/wolf/1uk4:refs/heads/wolf/1uk4\n  gh pr create --base stable");
    expect(cmds(f)).not.toContain("git merge --no-edit origin/stable");
    expect(cmds(f).filter((c) => c.startsWith("git fetch"))).toEqual([]);
    expect(f.verifyCalls()).toBe(0);
    expect(writes(f)).toEqual([]);
  });
});

describe("wolfpack pr prepare: arguments", () => {
  // parsePrArgs gets the raw argv after the node and script names, so it sees every flag the global layer ignores or passes through.
  const pr = (...rest: string[]) => ["pr", "prepare", ...rest];

  it("accepts exactly --full, --dry-run and --base <value>, wherever the command words sit", () => {
    expect(parsePrArgs(pr())).toEqual({ full: false, dryRun: false, base: undefined });
    expect(parsePrArgs(pr("--full", "--dry-run", "--base", "stable"))).toEqual({ full: true, dryRun: true, base: "stable" });
    expect(parsePrArgs(["--dry-run", "pr", "prepare"])).toMatchObject({ dryRun: true });
    expect(parsePrArgs(["pr", "--dry-run", "prepare"])).toMatchObject({ dryRun: true });
  });

  it.each([
    [pr("--feature", "work-wolfpack-feat0001"), /unknown argument "--feature"/],
    [pr("--bogus"), /unknown argument "--bogus"/],
    [pr("--host", "h"), /unknown argument "--host"/],
    [pr("stray"), /unknown argument "stray"/],
    [pr("--base"), /--base needs a value/],
    [pr("--base", "--full"), /--base needs a value/],
  ] as [string[], RegExp][])("rejects %j", (args, msg) => {
    expect(() => parsePrArgs(args)).toThrow(msg);
  });
});

describe("test totals", () => {
  it("reads the file and test totals from a real vitest summary", () => {
    const summary = [
      " RUN  v3.2.4 /repo",
      "",
      " Test Files  25 passed (25)",
      "      Tests  195 passed (195)",
      "   Start at  11:50:53",
      "   Duration  5.23s (transform 2.09s, setup 1.07s, collect 9.61s, tests 14.25s, environment 2ms, prepare 1.98s)",
      "",
    ].join("\n");
    expect(parseTotals(summary)).toBe("Test Files 25 passed (25); Tests 195 passed (195)");
    expect(parseTotals(" Test Files  1 failed | 24 passed (25)\n      Tests  2 failed | 193 passed (195)\n")).toBe("Test Files 1 failed | 24 passed (25); Tests 2 failed | 193 passed (195)");
    expect(parseTotals("no summary here")).toBeUndefined();
  });
});
