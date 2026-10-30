# Deploy hubd on sfo-01 (ticket work-wolfpack-gctZOIO)

Prepared, NOT yet run. Run only after owner confirmation. Never print `/etc/wolfpack/hubd.env` or tokens.

## Target state
| | |
|---|---|
| user / group | `hubd` / `hubd` (system, nologin). Never `wolf-W1hOrJ` (Dewey) |
| bind | Tailscale IP `100.120.154.69` only, port **3150** (3141 = wolfpack-agent; port confirmed free) |
| unit | `/etc/systemd/system/hubd.service`: `After=tailscaled`, `Restart=on-failure`, hardened (see file) |
| env | `/etc/wolfpack/hubd.env`, root:root 600 |
| code | `/opt/wolfpack-hubd/releases/<ts>-<sha>/hubd.mjs`, symlinks `current` and `previous` (node: `/usr/bin/node` v22) |
| data | `/var/lib/hubd` (0700): ledger, registry, tokens, `kb-rev`, `run`, hub-owned `kb/base`, `kb/ops` |
| KB read | `/var/lib/hubd/kb/base/domains` → `/home/wolf-W1hOrJ/knowledge/base/domains`, bound **read-only** by the unit |
| inbox/receipts | `/home/wolf-W1hOrJ/librarian/{inbox,receipts}` bound **read-write** by the unit; lane dirs `<lane>/1uk4` pre-created |

### How access works (no ACLs, `acl` is not installed and is not needed)
- On sfo-01 `/var/wolfpack/kb/base/domains` → `/home/wolf-W1hOrJ/knowledge/base/domains` and `/var/wolfpack/kb/ops/{inbox,receipts}` → `/home/wolf-W1hOrJ/librarian/{inbox,receipts}` are root-owned symlinks (Dewey runs with `KB_BASE=/var/wolfpack/kb/base`, `KB_OPS=/var/wolfpack/kb/ops`). The unit and hubd use the **real** `/home/...` paths, because the sandbox binds real paths.
- Modes: `/home/wolf-W1hOrJ` 755, `librarian` 755, `domains`/`inbox`/`receipts` 777, lane dirs 777; files in `domains/` 644, dirs 755 (Dewey umask 0022). hubd therefore already has what it needs as "other".
- **Because those dirs are world-writable, read-only KB comes only from the sandbox** (`BindReadOnlyPaths=` on `domains/`; no `-` prefix so a missing path fails the start).
- **UMask=0022**, data dir 0700. hubd's contribution files are written with the default mode, so they are 644 and Dewey can read them; Dewey moves/deletes them via write on the 777 lane dir. 0022 does not expose `/var/lib/hubd` (0700 dir) and `tokens.json` is written 0600 explicitly.
- **Lane dirs**: if hubd creates a NEW `inbox/<wolf>` dir it is hubd-owned 755 and Dewey cannot write into it. `setup.sh` pre-creates `inbox/<wolf>` and `receipts/<wolf>` (owner wolf-W1hOrJ, mode 777) for `--wolf` names (default `1uk4`). **A new wolf needs its lanes created before it contributes** (`setup.sh setup --wolf <name>`, idempotent; or `install -d -o wolf-W1hOrJ -g wolf-W1hOrJ -m 0777 .../inbox/<wolf> .../receipts/<wolf>`).
- **Lane subdirs**: inside an inbox lane, hubd creates `_bad/` (quarantine, `contributions.ts`) and Dewey's intake creates `_bad/` (`intake.ts quarantineBad`) and `_processed/` (`commit.ts markProcessed`, `renameSync` of handled files into it); both use `mkdir -p`, so whoever runs first owns the dir at 755 and the other cannot write into it. `setup.sh` therefore pre-creates `inbox/<wolf>/_bad` and `inbox/<wolf>/_processed` (wolf-W1hOrJ, 777) only when missing. Receipts: Dewey's pipeline writes `receipts/<wolf>/` (`pipeline.ts`); hubd writes nothing there yet, and no subdirs were found. A lane created later by someone else with a different owner/mode needs fixing by hand (`chown wolf-W1hOrJ`, `chmod 777`).

### What hubd writes into `domains/` (tested on a read-only copy, bundle from this branch)
- **Startup and serving work**: recovery, the KB revisions scan (`kb-rev/` is under the data dir), the registry (incl. `domains.yaml`, which lives in the hub-owned `kb/base`), pairing, tokens, link, event stream, reads. Verified: `hubd serve` started, scanned 2 domains, answered 401/201 with `domains/` unwritable.
- **Fails with domains/ read-only**: work-item writes (`POST /v1/work`, patch, claim, graduate…) render `domains/<d>/work/<id>.md` and return **502 engine_error** (EACCES; EROFS under the real sandbox); KB commits (`POST /v1/kb/commits`) write `domains/<d>/…` and fail the same way. Reads of work items are fine.
- No code change was needed for startup. Decision for the owner: if the hub should take work writes on sfo-01 now, run `setup.sh setup --hub-writes` — it adds a drop-in that makes only `domains/*/work` dirs writable. **UNTESTED under real systemd, and the owner has decided not to use it for now.** systemd does not expand globs, so the drop-in lists the work dirs found at setup time: after adding a domain or a work dir, re-run `setup --hub-writes`. If no work dirs exist, setup warns and writes no drop-in (an empty `BindPaths=` would drop the inbox/receipts binds). KB commits stay disabled until the hub is the KB's only writer (then the whole `domains/` bind becomes read-write, a unit change; stop Dewey's sweep writing the same tree first).
- Contributions go to Dewey's inbox: ticket 7 is merged, and `HUBD_INBOX_ROOT` / `HUBD_RECEIPTS_ROOT` (already set in the env template to the real `/home/wolf-W1hOrJ/librarian/{inbox,receipts}` paths) make hubd write `inbox/<wolf>/<file>.md` (rejects to `inbox/<wolf>/_bad/`) and poll `receipts/<wolf>/*.md` to relay to workers. The hub only reads receipts. If the variables are unset, contributions stay in `/var/lib/hubd/kb/ops/contributions/<wolf>/`. Other env hubd reads: `HUBD_PUBLIC_URL`, `HUBD_CONSOLE_URL`, KB poll/settle (`kbPollMs`, `kbSettleMs`) and relay/link timers are code options with defaults, not env vars. **Removed in ticket 11:** `HUBD_API_KEY` and the `X-Wolfpack-Actor` header no longer exist; `hubd serve` refuses to start while `HUBD_API_KEY` is set (even to a short value), so delete it from `/etc/wolfpack/hubd.env` before upgrading. Only per-device tokens (`hubd pair`) authenticate; clients use `WOLFPACK_HUB_TOKEN` (the old `WOLFPACK_HUB_KEY` is ignored).

## 0. Build (Mac)
```
npm ci && npx tsc --build
node deploy/hubd/build-bundle.mjs /tmp/hubd-bundle     # prints the sha256 of hubd.mjs
node /tmp/hubd-bundle/hubd.mjs | head -2               # expect "usage:"
```
## 1. Preflight (read-only, ssh as in ops.md)
```
node --version; command -v node                       # /usr/bin/node, >= 22
tailscale ip -4; systemctl is-active tailscaled
ss -ltnp | grep -E ':(3141|3150)\b'                   # only 3141 (agent); 3150 free
id hubd; ls -d /etc/wolfpack /opt/wolfpack-hubd /var/lib/hubd   # all absent on first run
stat -c '%a %U %n' /home/wolf-W1hOrJ /home/wolf-W1hOrJ/librarian /home/wolf-W1hOrJ/knowledge/base/domains /home/wolf-W1hOrJ/librarian/{inbox,receipts}
# real modes: -L follows the /var/wolfpack symlinks
find -L /home/wolf-W1hOrJ/knowledge/base/domains /home/wolf-W1hOrJ/librarian -type f -printf '%m %u\n' | sort | uniq -c
# files hubd could not read (after setup creates the user: setup.sh also runs this and warns, up to 20)
runuser -u hubd -- find -L /home/wolf-W1hOrJ/knowledge/base/domains ! -readable | head -20
```
Any `600`-mode files in the survey, or any unreadable file, means the hub's KB scan/serving will skip or fail on them: report to the owner before starting.

## 2. Copy (staging only)
```
S="ssh -i ~/.ssh/wolfpack -o IdentitiesOnly=yes -o IdentityAgent=none"
rsync -a --delete -e "$S" /tmp/hubd-bundle/ root@100.120.154.69:/root/hubd-stage/bundle/
rsync -a --delete -e "$S" deploy/hubd/ root@100.120.154.69:/root/hubd-stage/deploy/
```
## 3. Dry run, then real (on sfo-01 as root)
```
cd /root/hubd-stage/deploy
./setup.sh --dry-run setup --bind 100.120.154.69 --port 3150 --wolf 1uk4
./setup.sh --dry-run install --bundle /root/hubd-stage/bundle
# review; any "WOULD FAIL" line must be resolved. Then:
./setup.sh setup --bind 100.120.154.69 --port 3150 --wolf 1uk4      # add --hub-writes only if the owner wants work writes
./setup.sh install --bundle /root/hubd-stage/bundle
systemctl start hubd
```
`setup` dies (before installing anything) if node is not in /usr/bin|/usr/local/bin, port 3150 is held by anything but hubd, an existing env file has a bad port/host, `domains/` is not readable by hubd, or `inbox/`/`receipts/` (and lane dirs that exist) are not writable by hubd. It creates the hubd user first, then re-runs the access checks with `runuser -u hubd`. `install` smoke-tests the bundle, flips `current` atomically (rename), keeps 5 releases, restarts hubd only if already active.

## 4. Verify
`WOLFPACK_KB_WRITER=1` (in `hubd.env`, from `hubd.env.example`) turns off the worker-mirror write guard (`@wolfpack/kb` mirror-guard): hubd and the sfo-01 `wolfpack-agent` write the KB tree on purpose. Set it in the agent's environment too (its systemd unit/env file on the host, e.g. `Environment=WOLFPACK_KB_WRITER=1`); never set it on Mac workers.
```
systemctl is-active hubd; journalctl -u hubd -n 30 --no-pager        # "hubd listening on http://100.120.154.69:3150"
journalctl -k | grep -i seccomp                                      # nothing about hubd (a filtered call would show up here); also check journalctl -u hubd -p err
ss -ltnp | grep -E 'hubd|:3150'                                      # ONLY 100.120.154.69:3150; no 0.0.0.0, *, or [::]
ps -o user= -p "$(systemctl show -p MainPID --value hubd)"            # hubd (not wolf-W1hOrJ)
stat -c '%U:%G %a' /etc/wolfpack/hubd.env                            # root:root 600
curl -s -o /dev/null -w '%{http_code}\n' http://100.120.154.69:3150/v1/registry/wolves       # 401: up, tokens enforced (no unauthenticated health route)
curl -s -m 3 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3150/v1/registry/wolves       # 000: not on loopback
# as the hubd user (outside the sandbox these test plain file permissions)
runuser -u hubd -- test -r /home/wolf-W1hOrJ/knowledge/base/domains && echo kb-read ok
runuser -u hubd -- find -L /home/wolf-W1hOrJ/knowledge/base/domains -type f ! -readable | head   # must print nothing
runuser -u hubd -- test -w /home/wolf-W1hOrJ/librarian/inbox/1uk4 && echo inbox-lane-write ok
runuser -u hubd -- test -w /home/wolf-W1hOrJ/librarian/receipts/1uk4 && echo receipts-lane-write ok
runuser -u hubd -- test ! -r /home/wolf-W1hOrJ/.env && echo secrets-unreadable ok
# the unit file itself, and the unit's sandbox (same properties as hubd.service):
systemd-analyze verify /etc/systemd/system/hubd.service              # no output = ok (warnings about /opt/.../current before install are expected)
systemd-run --wait --pipe -p User=hubd -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=tmpfs -p PrivateTmp=yes -p PrivateDevices=yes \
  -p RestrictAddressFamilies="AF_INET AF_INET6 AF_UNIX" -p CapabilityBoundingSet= -p SystemCallFilter=@system-service -p SystemCallErrorNumber=EPERM \
  -p BindReadOnlyPaths=/home/wolf-W1hOrJ/knowledge/base/domains -p BindPaths="/home/wolf-W1hOrJ/librarian/inbox /home/wolf-W1hOrJ/librarian/receipts" \
  -p ReadWritePaths="/var/lib/hubd /home/wolf-W1hOrJ/librarian/inbox /home/wolf-W1hOrJ/librarian/receipts" \
  /bin/sh -c 'touch /home/wolf-W1hOrJ/knowledge/base/domains/.p 2>&1 | grep -q "Read-only" && echo kb-ro-in-sandbox ok; touch /home/wolf-W1hOrJ/librarian/inbox/1uk4/.p && rm /home/wolf-W1hOrJ/librarian/inbox/1uk4/.p && echo inbox-rw-in-sandbox ok; grep -E -A1 "^ *[|]-- 100[.]120[.]154[.]69$" /proc/net/fib_trie | grep -Fq "/32 host LOCAL" && echo addr-visible-in-sandbox ok'
systemctl is-active wolf-W1hOrJ wolfpack-agent                       # unchanged
```
Contribution mode check (after the first contribution): `stat -c '%U %a' /home/wolf-W1hOrJ/librarian/inbox/1uk4/*` should be `hubd 644`; if it is not readable by Dewey, tell the owner (an explicit file mode would go into ticket 7).

## 5. Register, pair, go online (host `mac-1uk4`, wolf `1uk4`, domains personal, snapjack, wolfpack)
workerd announces wolves by **name** (`1uk4`), not by id (ddkyhT). Wolves must be registered, with their domains, before the Mac connects; order: domains → host → wolves → pair → workerd.

1. A console (owner) token for the registry calls. On sfo-01 (single-use, 10 minutes):
```
umask 077; runuser -u hubd -- /usr/bin/node /opt/wolfpack-hubd/current/hubd.mjs pair --kind console --data-dir /var/lib/hubd
H=http://100.120.154.69:3150
TOKEN=$(curl -sS -H 'Content-Type: application/json' -X POST $H/v1/pair -d '{"code":"<code>","label":"sfo-admin","kind":"console"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')   # keep in the shell, never echo
A="Authorization: Bearer $TOKEN"; J='Content-Type: application/json'
```
2. Register (each returns 201):
```
for d in personal snapjack wolfpack; do curl -sS -H "$A" -H "$J" -X POST $H/v1/registry/domains -d "{\"name\":\"$d\"}"; echo; done
curl -sS -H "$A" -H "$J" -X POST $H/v1/registry/hosts  -d '{"name":"mac-1uk4"}'
curl -sS -H "$A" -H "$J" -X POST $H/v1/registry/wolves -d '{"name":"1uk4","host":"mac-1uk4","domains":["personal","snapjack","wolfpack"]}'
curl -sS -H "$A" $H/v1/registry/wolves
```
3. Pair the Mac (single-use code for exactly this host id). On sfo-01:
```
runuser -u hubd -- /usr/bin/node /opt/wolfpack-hubd/current/hubd.mjs pair --kind worker --host-id mac-1uk4 --data-dir /var/lib/hubd
```
   On the Mac, within 10 minutes: `workerd pair http://100.120.154.69:3150 <code>` (writes `~/.wolfpack/workerd/hub.json`, mode 0600; plain http is accepted inside Tailscale only; workerd prints a warning).
4. Start workerd on the Mac as usual. `runWorkerd` reads `hub.json` at startup (`packages/workerd/src/run.ts:61-71`, called from `bin/workerd.ts`) and opens the link.
5. Online check (there is no GET for presence):
   - `curl -sN -m 20 -H "$A" $H/v1/events` shows `wolf.presence` with state `online` for `1uk4`;
   - `journalctl -u hubd --since "5 min ago"` has no `rejected wolves` / `not registered` lines for `mac-1uk4`; workerd on the Mac logs `hub link: online (host mac-1uk4)`, and `ss -tnp state established '( sport = :<HUBD_PORT> )'` on the hub host (the `HUBD_PORT` you set; 3150 on sfo-01) lists the Mac's connection.

## 6. Rollback / removal
- Bad release: `./setup.sh rollback` (swaps `current` and `previous`).
- Remove hubd (leaves Dewey, the KB and the lane dirs untouched): `./setup.sh --dry-run uninstall`, then `./setup.sh uninstall`. It keeps `/var/lib/hubd`, the env file and the user; `uninstall --purge` removes them too (stop first and back the state up if it matters). **`hubd export` does not work on sfo-01**: its tree walk refuses symlinks (`refusing to export a symlink: kb/base/domains`, `export.ts walk`), so it fails safely and never reads Dewey's KB, but it also produces no backup. Back up with the service stopped; hubd is always restarted, even if tar fails:
```
systemctl stop hubd
( umask 077; tar --one-file-system -C /var/lib -cpf /root/hubd-state.tar hubd ); rc=$?
systemctl start hubd
[ "$rc" -eq 0 ] && echo "backup ok" || echo "BACKUP FAILED (tar rc=$rc); hubd restarted" >&2
```
(GNU tar stores the `domains` symlink as a link, not its contents; the tar holds tokens, so it is created 0600.) Restore, with hubd stopped and `/var/lib/hubd` moved aside: `tar -xpf /root/hubd-state.tar -C /var/lib` as root (`-p` and root's default `--same-owner` keep owner hubd:hubd and the 0700/0600 modes), then `systemctl start hubd`.
- No ACLs were set, so nothing in Dewey's tree needs undoing. Pre-created lane dirs are empty and harmless.
