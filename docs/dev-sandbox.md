# Dev sandbox: a production-like pack on this Mac

`npm run dev:stack:desktop` starts workerd, which supervises every wolf in `~/wolves/dev`, plus the Electron app. Two
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
  skipped); the destination must not overlap the live KB, `~/wolves/{knowledge,librarian,local,sfo-01}` or any Syncthing
  folder (paths read from `config.xml`, nothing else).
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
  Syncthing mirror (`--work-md-from`, default `~/wolves/knowledge/base`). After install the snapshot prints a cross-check of
  ledger ids vs `.md` files, and fails (installing nothing) if the ledger has events but no `.md` was found. No den, ops or KB comes from the host.
* The remote ledger is hashed over ssh before and after (`sha256sum -- <file>`, read-only). The snapshot fails loudly,
  installing nothing, if the copy's sha256 differs from the hash taken before, or the two remote hashes differ (a live
  append: just rerun). `--dry-run` runs `rsync -n --itemize-changes` only: nothing written, no hash.
* ssh uses the wolfpack key with `IdentitiesOnly`, `IdentityAgent=none`, `BatchMode`.

## Running it

```sh
npm run dev:stack:desktop      # or dev:stack for the browser console
```

`scripts/dev-stack.sh` needs `ANTHROPIC_API_KEY` only when the models file's transport is `api` (the dev `models.json` is
`subscription`: the Claude Agent SDK uses your local login). `dewey-dev` embeds with local Ollama
(`127.0.0.1:11434`, `nomic-embed-text`); the script warns if it is not answering.
To keep model usage low while testing, add `tiers: {main: {model: claude-haiku-5-5}, smart: {model: claude-haiku-5-5}}` to
the wolves' `wolf.yaml`.

**Extension bundles.** wolfd loads each wolf's extensions from the installed bundle in its den
(`<sandbox>/dens/<wolf>/extensions/<ext>/index.js`), which nothing else rebuilds. On every start `dev-stack.sh` builds the
CLI from this checkout and runs `sandbox install-extensions` for each sandboxed wolf whose bundle is missing or older than
its sources (`scripts/dev-stack-extensions.mjs`; one line per wolf: installed / up to date). Non-sandbox dens are only
warned about, never written. Set `DEV_STACK_NO_EXT_INSTALL=1` to skip. Do not use a global `wolfpack` for this: the CLI
bundles the checkout it lives in.

**Desktop notifications.** The dev Electron app is "Electron" in macOS: allow it under System Settings → Notifications →
"Electron" (it only appears there after the first notification attempt). Every notification decision (received, rejected
with the reason, shown, clicked) is written to the desktop main log; the renderer logs why it skipped one via
`console.debug` ("needs-you: no notification ...").

### Debugging the live chat stream

Set `WOLFPACK_DEBUG_STREAM=1` in the environment of the wolf process (wolfd) to log, for every in-flight assistant
`message_update`, the sequence of engine change types, e.g. `[wolfd stream] message_update changes=[text_start,text_delta]`.
`text_start` / `thinking_start` / `block` / `message` entries are the restream shapes that used to be dropped; if a reply
looks truncated, grep the wolf's log for these lines. With the dev stack: `WOLFPACK_DEBUG_STREAM=1 npm run dev:stack:desktop`.
Off by default.
