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
`wolfpack sync <wolf> --release` does not reach workerd-managed wolves yet (agent 404). Use `wolfpack deploy` (below): it talks ssh to the host, not the agent, so it works for workerd-managed wolves. It does not fix `sync` itself (that still 404s).

## Deploying a published release: `wolfpack deploy` (C3)
The host downloads a GitHub release itself (`<component>/vX.Y.Z`, see release.yml), verifies it, switches, health-checks and rolls back on failure.
    wolfpack deploy <wolf> --release wolfd/v0.1.2 [--host sfo-01] [--dry-run] [--health-timeout 60]     # --release takes wolfd/vX.Y.Z | vX.Y.Z | X.Y.Z
    wolfpack deploy --component hubd|workerd --release hubd/v0.2.0 --host sfo-01 [--dry-run]
The CLI pipes `infra/release/deploy-release.sh` over ssh (`sudo bash -s -- ...`; nothing is left on the host) and streams its output. Host: `--host`, else the one registered host whose wolves tree has the wolf, else the default host. Exit codes: 0 ok or no-op, 1 refused (nothing changed), 3 failed health check and rolled back (unit healthy again), 4 rollback unhealthy (needs a human).
Script (`deploy-release.sh <wolfd|hubd|workerd> <X.Y.Z> [--wolf n] [--dry-run]`, root, needs only curl sha256sum tar systemctl): download into a fresh `mktemp -d`; refuse on a missing/malformed/mismatching `.sha256`, a `.sha256` naming another component, unsafe tar paths or a VERSION that is not the requested one; unpack to `/home/wolf-<n>/.release.new.*` (owned by wolf-<n>) -> `release.prev` (an older prev is kept as `release.prev-<ver>-<ts>`, never deleted) -> `release`; restart `wolfd@<n>`; healthy = unit active, serving line `wolfd: <n> serving unix:/run/wolfd-<n>/serve.sock` in the journal since the restart, `journalctl -p err` empty after a settle; on failure the failed dir is kept as `release.failed-<ver>-<ts>`, the previous release is swapped back, restarted and re-checked. Same version already running = no-op, no restart. Refuses if the wolf's `.env` sets `ANTHROPIC_API_KEY` (name only). Old `release.prev-*` / `release.failed-*` dirs are never pruned automatically (each ~350 MB unpacked): delete by hand when the disk gets tight.
hubd/workerd: same download/verify/VERSION steps, then the release's own `setup.sh install --bundle` (keeps `previous`), health = `<comp>.service` active + no journal errors, failure -> `setup.sh rollback`. Their first-time `setup.sh setup` is still done by hand (RUNBOOK); `deploy` only upgrades.
Proof: `infra/release/deploy-proof.sh` (Docker, native arch; synthetic releases with the real URL layout from a local http server; systemctl/journalctl are doubles, so it proves the script logic, not systemd) prints `DEPLOY PROOF OK`.

### RUNBOOK: next wolfd upgrade of hal2 on sfo-01 (owner approves first)
After the tag `wolfd/vX.Y.Z` has been published by CI:
    wolfpack deploy hal2 --release wolfd/vX.Y.Z --host sfo-01 --dry-run     # prints the plan only
    wolfpack deploy hal2 --release wolfd/vX.Y.Z --host sfo-01
Without the CLI: `ssh root@sfo-01 'bash -s -- wolfd X.Y.Z --wolf hal2' < infra/release/deploy-release.sh`.
Check: `ssh root@sfo-01 'systemctl is-active wolfd@hal2; cat /home/wolf-hal2/release/VERSION; journalctl -u wolfd@hal2 -p err --since -5min'`. Manual rollback if ever needed: swap `/home/wolf-hal2/release` and `release.prev`, `systemctl restart wolfd@hal2`.
