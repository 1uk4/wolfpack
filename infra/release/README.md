# wolfd release tarball (H3)
    scripts/build-wolfd-release.sh [--arch x64|arm64] [--out DIR] [--with-cli]   # Docker; default x64 (DO droplet) -> dist-release/wolfd-<ver>-linux-<arch>.tar.gz
    scripts/smoke-wolfd-release.sh dist-release/wolfd-*-linux-x64.tar.gz          # clean node container, npm/npx tripwired, launch.sh, GET /v1/wolves
    wolfpack sync <wolf> --release <tarball>                                       # wolf with runtime: wolfd -> PUT /wolves/:id/bundle {runtime:"wolfd", tarball, models, env}

Contents: `packages/*/{package.json,dist}`, prod `node_modules` (harness workspace closure, glibc SDK native pkg only), `launch.sh`, `wolfd.service`
(template: @USER@ @HOME@ @RELEASE@ @MEMORY_MAX@ @NAME@; hardened, generated from infra/wolves/wolfd@.service), `templates/{wolf.yaml,models.json,.env.example}`, `tools/bin/claude` (-> the SDK's native binary),
`tools/install-claude-cli.sh` (pinned claude-code, optional), `VERSION`. Never a `.env` (the build fails if one is present).
Agent: unpacks to `<wolf home>/release` (previous kept as `release.prev`), `agent/launch.sh` execs `release/launch.sh`.

## Memory and KB through the hub (H6)
A VPS wolf has no Syncthing. With `WOLFPACK_HUB_KB=1` in its `.env`, wolfd syncs the KB itself from hubd into `<home>/kb-mirror` and feeds `<home>/ops/inbox/<wolf>/*.md` to hubd `POST /v1/contributions` (`packages/harness/src/wolfd/hub-kb.ts`). `.env` keys: `WOLFPACK_HUB_KB`, `WOLFPACK_HUB_URL`, `WOLFPACK_HUB_TOKEN` (a worker token of the wolf's host), `WORK_ENDPOINT=<hub>/v1/workapi`, `WORK_TOKEN` (the same token). wolf.yaml needs `domains: [...]` (must match the registry), `extensions: [memory]` (the memory bundle also carries the tasks tools) and `memory.live: true`. The memory bundle goes to `<home>/den/extensions/wolfpack-memory/index.js` (build it with `buildDurableExtension("memory", dir)` from `packages/cli/dist/bundle.js`).
Work API: hubd serves a host-scoped proxy at `/v1/workapi/work` (`packages/hubd/src/work-proxy.ts`). **On sfo-01 the hubd sandbox keeps `domains/*/work` read-only (RUNBOOK.md, `setup.sh` without `--hub-writes`), so only the proxy's reads work there; a create/patch fails with EROFS** (`open .../domains/<d>/work/<id>.md.tmp-...`) after the ledger event is already appended, leaving a ledger-only item. The graduation preview itself only reads work items (its one write is the token file `<den>/tasks/graduation/<token>.json`); it is proven by `infra/tracer/run-tracer.sh --kb`, not on sfo-01.
A new wolf needs its contribution lanes first (`install -d -o wolf-W1hOrJ -g wolf-W1hOrJ -m 0777 .../librarian/{inbox,receipts}/<wolf>`). Keep a contribution's `domain_hint` to a real KB domain: Dewey parks one for an unknown domain (EACCES on `mkdir domains/<hint>/entries`).
`wolfpack sync <wolf> --release` does not reach workerd-managed wolves yet (agent 404): unpack the tarball into `<home>/release` (previous kept as `release.prev`) by hand.
