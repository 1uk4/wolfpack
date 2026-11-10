import { describe, expect, it } from "vitest";
import { checkWorkerCommand } from "./command-guard.js";

const ALLOWED = [
  "git add a.ts b.ts",
  "git commit -m 'x (work-wolfpack-abc)' -- a.ts",
  "git commit --fixup abc123 -- a.ts",
  "git status --short",
  "git diff HEAD~1",
  "git log --oneline main..HEAD",
  "git show HEAD:a.ts",
  "git rev-parse --abbrev-ref HEAD",
  "git merge-base HEAD wolf/1uk4",
  "git ls-files | head",
  "git blame a.ts",
  "git grep -n foo",
  "git branch --show-current",
  "GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash abc123",
  "git rebase --autosquash",
  "git rebase wolf/1uk4",
  "git rebase --abort",
  "git rebase --continue",
  "GIT_EDITOR=true git rebase --continue",
  "git rebase --skip",
  "git restore a.ts",
  "git restore --staged -- a.ts b.ts",
  "git rm old.ts",
  "git mv a.ts b.ts",
  "git checkout -- a.ts",
  "git --version",
  "git config --get user.name",
  "git remote -v",
  "pnpm build && git status; echo done",
  "pnpm exec vitest run a.test.ts",
  "sh scripts/check.sh",
  "sh -c 'git status'",
];

const REFUSED = [
  // repository-changing and network commands
  "git push", "git push origin HEAD", "git merge main", "git reset --hard", "git checkout other", "git checkout a.ts", "git switch other",
  "git branch -D x", "git branch -d x", "git branch -m y", "git branch newbranch", "git tag v1", "git remote add o u", "git config user.name x",
  "git stash", "git cherry-pick abc", "git clean -fd", "git worktree add ../x", "git update-ref -d refs/heads/x",
  "git -c core.sshCommand=x status", "git commit --amend", "git commit --amend --no-edit", "git rebase -i abc",
  "git rebase --onto a b", "git rebase --root", "git rebase -x 'git push' main", "git rebase --autosquash --exec 'git push'", "git rebase a b",
  "git pull", "git fetch", "git restore --source=other a.ts", "git restore -s other a.ts",
  // other worktrees and repositories
  "git -C /tmp/x status", "git -C /tmp/x commit -m x", "git --git-dir=/x/.git status", "git --git-dir /x/.git status", "git --work-tree=/x status", "git --work-tree /x add .",
  // programs git would run, files git would write
  "git grep -O'sh' x", "git grep -nOsh x", "git grep -inO x", "git log --output=/tmp/x", "git diff --output /tmp/x", "git show --output=f HEAD",
  // gh
  "gh pr create", "gh auth status", "gh api repos/x/y", "/usr/local/bin/gh pr merge 1",
  // wrappers, chains and substitutions
  "env git push", "/usr/bin/git push", "command git push", "git -C /tmp/x push", "sh -c 'git push'", "bash -lc \"git push\"",
  "echo hi; git push", "true && git push", "false || git push", "echo x | git push", "echo $(git push)", "echo `git push`",
  "sudo git push", "timeout 5 git push", "nohup git push", "xargs git push", "find . -exec git push ;", "eval 'git push'",
  "ssh host 'git push'", "env -i git push", "\"git\" push", "g=1 git push", "env gh pr create", "sh -c 'echo $(gh pr create)'",
  "GIT_SSH_COMMAND='ssh -i k' git status", "GIT_CONFIG_COUNT=1 git status", "GIT_SEQUENCE_EDITOR='git push' git rebase -i --autosquash abc",
  "GIT_EDITOR='git push' git rebase --continue", "GIT_DIR=/x git status", "GIT_WORK_TREE=/x git status", "export GIT_EDITOR='git push'",
  "env -S 'git push'", "env -iS 'git push'", "env --split-string='git push'",
  // programs fed to a shell, sourced files, package runners
  "echo 'git push' | sh", "echo 'git push' | bash -s", "sh <<< 'git push'", "bash <<EOF\ngit push\nEOF", "bash <(echo 'git push')", "sh < /tmp/x.sh",
  "sh /tmp/x.sh", "bash ../x.sh", "bash $SCRIPT", "source x.sh", ". ./x.sh",
  "pnpm exec git push", "pnpm -r exec git push", "npx git push", "npx -y gh pr create", "npm exec -- git push", "pnpm dlx gh pr create",
];

// non-git commands the guard leaves alone
const UNTOUCHED = ["rm -rf build", "echo hi > out.txt", "sed -i s/a/b/ f", "pnpm install", "python3 -c 'print(1)'", "node -e 'console.log(1)'", "cat .gitignore"];

describe("console tests only through the queue", () => {
  const BLOCKED = [
    "cd apps/console && npx tsx --test tests/jobs.test.ts",
    "NODE_ENV=test npx tsx --test tests/a.test.ts",
    "./node_modules/.bin/tsx --test tests/a.test.ts",
    "pnpm exec tsx --test tests/a.test.ts",
    "pnpm --filter @wolfpack/console exec tsx --test tests/a.test.ts",
    "node --import tsx --test tests/a.test.ts",
    "node --loader tsx --test tests/a.test.ts",
    "bash scripts/test.sh tests/a.test.ts",
    "sh apps/console/scripts/test.sh",
    "./scripts/test.sh tests/a.test.ts",
    "ls tests/*.test.ts | xargs -n1 npx tsx --test",
    "find tests -name '*.test.ts' -exec npx tsx --test {} ;",
    "for f in tests/*.test.ts; do wolfpack test run $f; done",
    "ls apps/console/tests/*.test.ts | while read f; do wolfpack test run $f; done",
    "until false; do wolfpack test run a.test.ts; done",
  ];
  // (the guard is a nudge for a cooperative worker, not a sandbox: an interpreter or a script can still start tsx)
  it.each(BLOCKED)("refuses %s and names wolfpack test run", (c) => {
    const r = checkWorkerCommand(c);
    expect(r).toMatch(/^Blocked by bash/);
    expect(r).toContain("wolfpack test run");
  });
  it("words a loop refusal as running named files through wolfpack test run", () => {
    expect(checkWorkerCommand("for f in a.test.ts b.test.ts; do echo $f; done")).toContain("run named files through `wolfpack test run`");
  });
  it.each([
    "wolfpack test run apps/console/tests/a.test.ts",
    "npx tsx scripts/x.ts",
    "for f in a b; do echo $f; done",
    "ls tests/*.test.ts",
    'grep -n "while" foo.test.ts',
    'echo "see x.test.ts for details"',
    "git log --grep=for -- a.test.ts",
  ])("allows %s", (c) => expect(checkWorkerCommand(c)).toBeNull());
});

describe("worker git allowlist", () => {
  it.each([...ALLOWED, ...UNTOUCHED])("allows %s", (c) => expect(checkWorkerCommand(c)).toBeNull());
  it.each(REFUSED)("refuses %s", (c) => expect(checkWorkerCommand(c)).toMatch(/^Blocked by bash/));
});
