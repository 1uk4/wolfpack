# Dev sandbox: a production-like pack on this Mac

The snapshot sandbox (started by hand, see "Running it") runs workerd, which supervises every wolf in `~/wolves/dev`. Two
durable wolves there run **exactly like production, fully sandboxed**:

| wolf | role | what it does |
|---|---|---|
| `1uk4-dev` | the durable twin of 1uk4 | memory on; real work items; your real den; `promote` emits contributions |
| `dewey-dev` | a dev librarian (`memory.librarian: true`) | sweeps `1uk4-dev`'s inbox on a 1-minute timer into the **KB copy**; chat with it and use `kb_status`, `kb_inbox`, `kb_sweep_start`, `kb_sweep_status`, ... |

The loop closes locally: `1uk4-dev` talks, `consolidate`, `promote` (contribution lands in `ops/inbox/1uk4-dev/`), then
`dewey-dev` sweeps it into `kb-base/` and writes `ops/receipts/1uk4-dev/<topic>-<hash>.md`, and the next promote (or a
restart) runs `reconcileDen`, which archives the absorbed den topic into `memory/archive/`.

## Layout: one shared root, `~/wolves/dev/sandbox`

```
sandbox/
  snapshot.json            manifest: sources, counts, den path, ledger sha256 (also the "this is a sandbox" marker)
  ledger/work-events.jsonl ONE ledger copy      \  served by ONE local work server
  base/domains/<d>/work/*.md  work item files   /  (loopback, token in run/work-server.json, mode 0600)
  kb-base/                 COPY of the KB base  -> KB_BASE   (Dewey writes here; no work/ dirs: the work server owns them)
  ops/{inbox,receipts,parked}/<wolf>/             -> KB_OPS    (lanes are named by wolf NAME: 1uk4-dev, dewey-dev)
  dens/<wolf>/             a separate den per wolf -> WOLF_DEN; den-local KB state at dens/<wolf>/kb (KB_DEN_LOCAL)
  run/work-server.{json,lock}  the single writer's run file + lock
  .staging-*/ .replaced-*/     snapshot working dirs (see "Refreshing")
```

A single-wolf root (`den/` instead of `dens/<wolf>`, no `kb-base/`) still works: `resolveSandbox` uses `dens/<wolf>` only
when `dens/` exists, and sets `KB_BASE` only when `kb-base/` exists (otherwise `KB_BASE` stays ambient and read-only, and a
librarian is refused).

`~/wolves/dev/{1uk4-dev,dewey-dev}/wolf.yaml` point at it with `sandbox: {root: ~/wolves/dev/sandbox}`. `1uk4-dev` has
`extensions: [memory]`, the three real domains (`personal`, `snapjack`, `wolfpack`), `memory.defaultDomain: wolfpack` and
pi's consolidation defaults (trigger hybrid, 4h; threshold 20000, poolTarget 10000). `dewey-dev` is the same plus
`memory.librarian: true` and `sweepInterval: 1m`. The bundles in `dens/<wolf>/extensions/` are built from this checkout by
`wolfpack sandbox snapshot` / `add-wolf` / `install-extensions` (rerun after editing an extension).

## Safety guarantees

* **Nothing outward points at a live location.** `startSandbox` resolves every root into the sandbox and `assertSandboxed`
  proves it (fails closed): den, KB_OPS, KB_DEN_LOCAL, a loopback WORK_ENDPOINT, and **KB_BASE once a KB copy exists**
  (unset or live is refused). The sandbox env overrides ambient `KB_BASE/KB_OPS/WORK_*/WOLF_DEN` (checked with decoy dirs).
* **Librarian only on a copy.** `librarian: true` is allowed only when `<root>/kb-base` exists and KB_BASE, KB_OPS, the
  den-local state, the sweep lock, vectors and both ledgers all resolve inside the root
  (`assertLibrarianSandboxed`, enforced in `startSandbox`, the memory gate and `createWolfHarness`). Otherwise it is refused.
* **Exactly one work-ledger writer.** The server is started once per root: workerd starts it before the wolves and every
  wolfd attaches via `run/work-server.json` (pid + url + token). Without workerd the first wolf starts it. A second writer
  fails loudly (`<root>/run/work-server.lock`, exclusive create + pid liveness; stale locks are taken over).
* **Snapshots never touch the sources.** Local sources are read-only copies (never `--delete`, never `mv`, symlinks
  skipped); the destination must not overlap the live KB, `~/wolves/{knowledge,librarian,local,sfo-01}` or any den-backup Syncthing
  folder (paths read from `config.xml`, nothing else). Syncthing carries den backups only.
* **Nothing is deleted.** `--force` and `--refresh-work` move the previous parts to `.replaced-<ts>/`; a snapshot is
  staged in `.staging-<ts>/` and installed only after verification. A snapshot refuses to swap the ledger while the work
  server runs.
* **The remote part is read-only by construction** (below).

## What `1uk4-dev` copies from 1uk4's den (pi den -> durable)

Compatible as-is: `memory/topics` + `memory/archive` (same frontmatter: `id/title/summary/updated/absorbed_into`),
`kb/` den-local state (`emitted.json`, `distill/`, ledgers; durable's `denLocal` is `<den>/kb`, the same place), `usage/`.
Not carried or unused by durable: pi's pending observation pool (status.json's `observations`/`poolTokens`: it lives in the
pi session, not the den), `tasks/active.md` (durable binds per conversation: `tasks/active.json` and `factory/conversations`
are stripped), `factory/sessions`, `memory/sessions.json` (durable uses `.memory/sessions/<wolf>/`), `session.sqlite*`
(a fresh conversation starts), `extensions/` (current bundles are installed instead). Bulk that durable ignores is copied
anyway (`crawls/`, `viz/`, `stale-*`).

## Building / refreshing

```sh
# 1. one-time: the sandbox from local sources (den + KB copy are local; the ledger stand-in is an empty local dir)
wolfpack sandbox snapshot 1uk4-dev --dev-root ~/wolves/dev/sandbox --shared --extensions memory \
  --den ~/wolves/local/1uk4/den --kb-base ~/wolves/knowledge/base --work-from <dir-with-ledger/work-events.jsonl>
wolfpack sandbox add-wolf ~/wolves/dev/sandbox dewey-dev --extensions memory \
  --librarian-state ~/wolves/sfo-01/dewey/den      # seeds dewey-dev's KB ledger/vectors/sections (read-only source)

# 2. the real work items: ONLY the ledger + work .md files come from sfo-01 (stop the dev stack first)
wolfpack sandbox snapshot 1uk4-dev --dev-root ~/wolves/dev/sandbox --refresh-work --ledger-from-host sfo-01 --print-plan  # prints, contacts nothing
wolfpack sandbox snapshot 1uk4-dev --dev-root ~/wolves/dev/sandbox --refresh-work --ledger-from-host sfo-01 --dry-run     # rsync -n: lists files
wolfpack sandbox snapshot 1uk4-dev --dev-root ~/wolves/dev/sandbox --refresh-work --ledger-from-host sfo-01 --yes         # the real pull
```

`--refresh-work` re-pulls just the ledger and item files; dens, ops lanes and the KB copy (with Dewey's entries) stay. The
old ledger and items go to `.replaced-<ts>/`. To rebuild everything (e.g. a newer KB or den) rerun step 1 with `--force`
(old parts are again moved aside, other wolves' dens are left alone).

### The remote pull

* rsync with the remote path as **source only**; no `--delete*`, no `--remove-source-files`, no `--rsync-path`
  (`assertReadOnlyRsyncArgv` refuses them before spawning); explicit filter: only `/ledger/work-events.jsonl` under
  `/var/wolfpack/kb/work/`. The work item `.md` files are NOT pulled from the host: they are copied read-only from the local
  KB mirror (`--work-md-from`, default `~/wolves/knowledge/base`). After install the snapshot prints a cross-check of
  ledger ids vs `.md` files, and fails (installing nothing) if the ledger has events but no `.md` was found. No den, ops or KB comes from the host.
* The remote ledger is hashed over ssh before and after (`sha256sum -- <file>`, read-only). The snapshot fails loudly,
  installing nothing, if the copy's sha256 differs from the hash taken before, or the two remote hashes differ (a live
  append: just rerun). `--dry-run` runs `rsync -n --itemize-changes` only: nothing written, no hash.
* ssh uses the wolfpack key with `IdentitiesOnly`, `IdentityAgent=none`, `BatchMode`.

## Running it

Run the sandbox with `pnpm dev:stack [--app console|none]` (`scripts/dev-stack.mjs`). It builds this checkout (turbo;
`DEV_STACK_SKIP_BUILD=1` skips it), then starts workerd (`DEV_WORKERD_PORT`, default 7151) and, unless `--app none`, the
console (`DEV_CONSOLE_PORT`, default 3220) against the wolves folder `DEV_WOLVES_DIR` (default `~/wolves/dev-sandbox`).
If that folder holds no wolf it scaffolds one minimal wolf ("sandbox"); wolves already there (e.g. a snapshot taken above)
are used as they are. It refuses any path touching `~/wolves/local` and the live ports, runs with `HOME=<sandbox>/.home` and
no inherited `WOLF_*`/`WOLFPACK_*` vars, and Ctrl-C stops every process. `WOLFPACK_MODELS_FILE` overrides the scaffolded
`models.json`. It does not run the extension install below, the Ollama check or the api-key check. There is no
attach mode and there are no `sandbox:stack*` or `dev:stack:desktop` scripts; the desktop app is started by hand
(`pnpm --filter @wolfpack/desktop dev`).

A models file with transport `api` needs `ANTHROPIC_API_KEY` (e.g. in `~/.wolfpack/.env`); the dev `models.json` is
`subscription`: the Claude Agent SDK uses your local login. `dewey-dev` embeds with local Ollama
(`127.0.0.1:11434`, `nomic-embed-text`); start it first or its sweep backs off.
To keep model usage low while testing, add `tiers: {main: {model: claude-haiku-5-5}, smart: {model: claude-haiku-5-5}}` to
the wolves' `wolf.yaml`.

**Extension bundles.** wolfd loads each wolf's extensions from the installed bundle in its den
(`<sandbox>/dens/<wolf>/extensions/<ext>/index.js`), which nothing else rebuilds. Run `node scripts/dev-stack-extensions.mjs ~/wolves/dev` by hand before starting; it builds the
CLI from this checkout and runs `sandbox install-extensions` for each sandboxed wolf whose bundle is missing or older than
its sources (one line per wolf: installed / up to date). Non-sandbox dens are only
warned about, never written. Set `DEV_STACK_NO_EXT_INSTALL=1` to skip. Do not use a global `wolfpack` for this: the CLI
bundles the checkout it lives in.

**Desktop notifications.** The dev Electron app (`pnpm --filter @wolfpack/desktop dev`, by hand) is "Electron" in macOS: allow it under System Settings → Notifications →
"Electron" (it only appears there after the first notification attempt). Every notification decision (received, rejected
with the reason, shown, clicked) is written to the desktop main log; the renderer logs why it skipped one via
`console.debug` ("needs-you: no notification ...").

### Debugging the live chat stream

Set `WOLFPACK_DEBUG_STREAM=1` in the environment of the wolf process (wolfd) to log, for every in-flight assistant
`message_update`, the sequence of engine change types, e.g. `[wolfd stream] message_update changes=[text_start,text_delta]`.
`text_start` / `thinking_start` / `block` / `message` entries are the restream shapes that used to be dropped; if a reply
looks truncated, grep the wolf's log for these lines. With the dev stack: `WOLFPACK_DEBUG_STREAM=1 on the workerd you start`.
Off by default.

## Updating the runtime checkout

`pnpm runtime:update [--dry-run]` brings the live stack up to `origin/stable` after the owner has merged a release PR:
it fetches `stable`, fast-forwards the `stable` runtime checkout (and refuses if it cannot), runs `turbo run build`,
rebuilds stale den extension bundles for non-sandbox wolves (old dir kept as `extensions.bak-<ts>`), and says whether to
reload the console (Cmd-R) or restart the stack. It never merges a branch, never rebases and never pushes; a branch argument
is refused (open a release PR with `wolfpack pr prepare` instead). The `stable` worktree is found via `git worktree list`;
override with `RUNTIME_BRANCH`, `WOLVES_DIR`. It needs to reach `origin` to fetch; offline, only `--dry-run` works (it does not fetch).

### Live-edit the console from a worktree

The fastest loop for UI work: every save shows in the desktop app within seconds, with no build and no wolf restart.

```sh
cd <worktree> && wolfpack preview dev     # or: wolfpack preview dev <dir>
```

Then reload the app with ⌘R (quit and reopen Wolfpack Console the first time), and run `wolfpack preview off` when done.

`dev` serves `next dev` from `<dir>/apps/console` (default: the git worktree containing cwd; it needs `pnpm install` there first)
on `127.0.0.1:3230` (`PREVIEW_CONSOLE_PORT`) against the local wolfd (`WOLFPACK_API_URL=http://127.0.0.1:7141`), under the same
launchd agent as the ref preview (`com.wolfpack.preview-console`, log `~/.wolfpack/preview/console.log`), so only one preview
console exists. It waits up to 90 s for `/api/wolves` to list a wolf (the first request compiles), then points the app's
`console.json` with the same record-and-restore safety as below. It never checks out, builds or restarts the wolves, so it works
with the wolves on stable or on a ref preview. If port 3230 is held by something else (a hand-started `next dev`), it refuses.

- `wolfpack preview dev <other dir>` while one is active switches the source in place (apps are kept; the original consoleUrl is never overwritten). The same dir again is a restart.
- `wolfpack preview <new ref>` while a ref preview is active switches in place too, keeping the first preview's previous ref and branch; a dev console is left running.
- `wolfpack preview off` stops the dev console and restores the app. It touches the wolves only if a ref preview is also active.
- `wolfpack preview status` (and `--json`) shows the mode and dir. A worker worktree is deleted when the worker finishes: status then says the dir no longer exists; run `wolfpack preview dev` from another worktree, or `off`.
- A branch literally named `dev` cannot be previewed by that name (use `origin/dev`).

### Preview a worktree: wolves and console straight from a built tree

`wolfpack preview` with no argument opens the CLI's arrow-key picker (the numbered list only when there is no terminal). One short
line per worktree: the branch without `feat/` and cut to its id and two words (`yu741qH-floating-chat…`), a worker's copy by its
worker name (`detach-chat (worker)`), then a mark: **● built, ◐ stale, ○ not built**, plus `active` and `edited`. The highlighted
row's hint shows the path, and "builds first, ~3 min" for a stale or not-built row: picking one builds it (install plus build, output
in `~/.wolfpack/preview/last-run.log`) and then starts the preview. Active comes first, then the worktree you are in, then the
newest commit. `stable`, the main checkout, detached heads and branches already merged into `wolf/1uk4` or `stable` with no edits
are hidden; "Show all worktrees…" at the bottom lists them. A worktree is built when a stamp
(`~/.wolfpack/preview/builds/<hash>.json`, kept outside the worktree so it never looks dirty) says so, or, with no stamp, when its
`workerd.js` and cli `dist` are newer than its HEAD commit.

Picking a worktree runs the wolves **straight from it**: no copy and no rebuild. `~/Library/LaunchAgents/com.wolfpack.stack.plist`
is rewritten so its working directory and `workerd.js` path point at the worktree (everything else is kept); the original bytes
are recorded in the state file and in `~/.wolfpack/preview/stack.plist.orig`, and restored exactly by `off --all` and by an
automatic rollback. The live console (`next dev`, as in `preview dev`) is served from the same worktree. The runtime checkout is
not touched. Because this restarts the wolves (and ends the wolf session running the command), it asks y/N first; with no terminal
it needs `--yes`. Explicit forms: `wolfpack preview <worktree dir> [--build] [--yes]`; `wolfpack preview <ref>` still works for a
commit with no worktree (it asks y/N too).

While a worktree preview runs:

- **Console edits** are live through `next dev`; nothing to do.
- **Backend edits** are rebuilt in the background by the launchd agent `com.wolfpack.preview-watch` (`tsc --build --watch` on the
  worktree, log `~/.wolfpack/preview/watch.log`). The wolves keep running the old code until you restart them: `status` (and
  `status --json`, field `restartNeeded`) says **restart needed** once a rebuild finished after the wolves started, and
  `wolfpack preview restart` asks y/N, runs `launchctl kickstart -k gui/<uid>/com.wolfpack.stack` and waits for `/healthz`. There
  is no automatic restart: it would cut off the wolf making the edits.
- `wolfpack preview off` asks **Live console only** (the app goes back to its own console, the wolves stay) or **Wolves too**
  (the plist is restored, the watcher stopped, everything back on stable). `--console` and `--all` skip the question; with no
  terminal and no flag it prints the choices and exits 1.
- **The `wolfpack` command follows the worktree.** The global `wolfpack` is a symlink (`.../lib/node_modules/@wolfpack/cli`) to the
  runtime's `packages/cli`, and stable's CLI has no `preview`. So starting a worktree preview records that link's target in the
  state file, then points it at `<worktree>/packages/cli` (which must be built); a switch repoints it, keeping the original, and
  `off --all` and rollback put the original target back. `off --console` leaves it. If the global `wolfpack` is a real install
  rather than a link, or neither the worktree's cli nor the checkout the preview script came from has the `PREVIEW_CLI` marker
  (a worktree branched before this feature has an older `preview` command that would misread the state: the link then goes to the
  script's own checkout, with a line saying so), it is not touched; use `node ~/.wolfpack/preview/bin/runtime-preview.mjs status|restart|off` instead.
- If the worktree is deleted while active (a worker's copy), `status` says so; `off --all` still restores the plist.

Every `wolfpack preview` command refreshes `~/.wolfpack/preview/bin/`, and the CLI runs whichever of that copy and its own
checkout's script has the higher `PREVIEW_VERSION` (a copy is never overwritten by a lower version), so the copy never goes stale. Stable's CLI has no `preview` command until this is released: until then run
`node ~/.wolfpack/preview/bin/runtime-preview.mjs ...` from any checkout that has it.

### Preview a branch on the live stack

`wolfpack preview <ref>` runs a branch on the Mac, `wolfpack preview status` shows where you are, and `wolfpack preview off`
returns to stable. `<ref>` is a branch or SHA. On `<ref>` it refuses a dirty runtime or a preview of another ref, fetches,
records `~/.wolfpack/preview/state.json`, then checks out the SHA (detached), installs and builds **while the wolves are still
up**. A failed build checks the previous ref back out and never stops the stack (state `build-failed`). After a good build a
detached helper (copied to `~/.wolfpack/preview/`) restarts `com.wolfpack.stack`, polls `/healthz` on 7141 for 60 s and logs to
`~/.wolfpack/preview/last-run.log`. Restarting ends the wolf session that ran the command: run `status` from Terminal.
`off` needs only the state file (it works after a crash at any phase): previous branch, fast-forward, install, build, restart,
clear state. Both take `--dry-run` (print the plan, change nothing). It never pushes or merges.

Beyond the switch itself:

- **Local console and the desktop app.** After a good switch the helper starts the preview build's standalone console
  (`apps/console/.next/standalone/apps/console/server.js`, with `.next/static` and `public` copied in) on `127.0.0.1:3230`
  (`PREVIEW_CONSOLE_PORT`), with `WOLFPACK_API_URL=http://127.0.0.1:7141`. It runs as its own launchd agent,
  `com.wolfpack.preview-console` (plist in `~/Library/LaunchAgents`), so it outlives the wolf session and the CLI, and survives a
  reboot; its log is `~/.wolfpack/preview/console.log`. Then, in each of `~/Library/Application Support/LearnHarness` and
  `Wolfpack Console` that exists, `console.json` is backed up (`console.json.preview-backup`), its old `consoleUrl` (or its
  absence) is recorded in the state file, and `consoleUrl` is set to the local console; other keys are kept. **Quit and reopen
  Wolfpack Console** (the app is never killed). `off` restores each file exactly (or removes the key), stops the agent and
  removes its plist. `PREVIEW_USERDATA_ROOT` overrides the userData root (tests use it).
- **Deep health check and rollback.** `/healthz` alone is not enough: the console must list at least one wolf on `/api/wolves`
  and return a list on `/api/chats` (wolfd's `/v1/wolves` only tells a dead console from a dead wolfd). If that fails within
  the timeout, the helper stops the console, checks out `previousRef`, builds, restarts and ends in phase `rolled-back` with
  the `reason` in the state (see `wolfpack preview status`). A rollback that itself fails ends `stack-down`: use the manual way back.
- **`off` from an old branch.** Every preview command copies the preview scripts and their imports to `~/.wolfpack/preview/bin/`; `wolfpack
  preview` runs that copy when present. The guaranteed way back is `node ~/.wolfpack/preview/bin/runtime-preview.mjs off`.
- **Refs.** `origin/<ref>` is preferred, unless the local `<ref>` is ahead of it or has diverged: then the local one is used
  with a warning. A detached runtime is found at `WOLVES_DIR/runtime/wolfpack` (or `~/wolves/local/runtime/wolfpack`) and its
  previous branch defaults to `RUNTIME_BRANCH`. If local `stable` is ahead of `origin/stable`, `off` warns and stays on the local one.
- **Output.** Build output goes to `~/.wolfpack/preview/last-run.log` (one progress line on the terminal).
  `wolfpack preview status --json` prints the state, `consoleUrl` and the last log lines. Use `pnpm runtime:update` for
the normal stable update, which still refuses a branch argument.

#### Manual way back

For a **worktree preview** the runtime checkout was never touched, so the way back is the saved plist (the helper prints this too):

```sh
cp ~/.wolfpack/preview/stack.plist.orig ~/Library/LaunchAgents/com.wolfpack.stack.plist && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.wolfpack.stack.plist
rm -f ~/.wolfpack/preview/state.json
```

For a ref preview:

If `node ~/.wolfpack/preview/bin/runtime-preview.mjs off` does not work, or the helper reports `stack-down` or `unhealthy` (it prints this block too):

```sh
cd ~/wolves/local/runtime/wolfpack && git checkout stable && pnpm install --frozen-lockfile --prefer-offline && node scripts/turbo.mjs run build
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.wolfpack.stack.plist
rm -f ~/.wolfpack/preview/state.json   # when the stack is back on stable
```

The helper refuses to stop anything when the plist is missing (`plist-missing`), retries `launchctl bootstrap` five times
(2 s apart) after the bootout, and records `stack-down` if that never works.
