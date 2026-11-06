# Deploy hubd on sfo-01 (ticket work-wolfpack-gctZOIO)

Prepared, NOT yet run. Run only after owner confirmation. Never print `/etc/wolfpack/hubd.env` or tokens.

## Target state
| | |
|---|---|
| user / group | `hubd` / `hubd` (system, nologin). Never `wolf-W1hOrJ` (Dewey) |
| bind | Tailscale IP `100.120.154.69` only, port **3150** (3141 was the legacy wolfpack-agent, retired 2026-11-06; never use 3141) |
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
- No code change was needed for startup. **Hub work writes (`setup.sh setup --hub-writes`) are TESTED under real systemd 252** (`deploy/hubd/hub-writes-proof.sh`: privileged container, real setup.sh, real bundle; prints `HUB WRITES PROOF OK`). The status code of a refused write is **502** (`engine_error`) with `details.code` / `code` `work_store_read_only` (EROFS) or `work_store_permission_denied` (EACCES). The drop-in lists the `domains/*/work` dirs found at setup time (systemd does not expand globs), so a domain or work dir added later stays read-only until you re-run `setup --hub-writes`, daemon-reload and restart. If no work dirs exist, setup warns and writes no drop-in. The bind alone is not enough: the dirs are `root:root 755` on sfo-01, so hubd got EACCES (`work_store_permission_denied`) in the proof. **Never 777** (every local user, i.e. each wolf's Linux user, could then write work items and bypass hubd's auth). Setup therefore does one of two things: if `setfacl` exists it adds a user ACL for `hubd` (access + default); otherwise (**sfo-01: `acl` is not installed, root fs ext4; installing it needs the owner's OK, and stock Debian does not ship it in a minimal image**) it creates the system group `wolfpack-work`, adds `hubd` (and every `--work-user USER`, e.g. Dewey's `wolf-W1hOrJ` if he should write there) to it, and sets each listed work dir to group `wolfpack-work`, mode `2775` (setgid: files created later inherit the group). hubd writes items as temp file + rename (`atomicWrite`), so directory write access is enough to PATCH a 644 file owned by Dewey (the item then belongs to hubd). The ACL path is not exercised by the proof (no `acl` in the test image); the group path is. Other users (e.g. a wolf's Linux user) cannot create or change files in `work/`. Everything else under `domains/` (entries, the domain root, new domains) stays read-only inside the unit. Re-running setup WITHOUT the flag deletes the drop-in (it says so); restart hubd to apply. KB commits stay disabled until the hub is the KB's only writer (then the whole `domains/` bind becomes read-write, a unit change; stop Dewey's sweep writing the same tree first).

**Enable on sfo-01 (as root, on the host, after the owner confirms):**
```
/opt/wolfpack-hubd/setup.sh --dry-run setup --hub-writes      # shows the work dirs and the drop-in; changes nothing
/opt/wolfpack-hubd/setup.sh setup --hub-writes                # add --bind/--port/--wolf as for the first setup, and --work-user wolf-W1hOrJ if Dewey must write work/ (no setfacl on sfo-01 -> group wolfpack-work, 2775); writes /etc/systemd/system/hubd.service.d/work-writes.conf
systemctl daemon-reload && systemctl restart hubd
systemctl show hubd -p DropInPaths                            # lists work-writes.conf
journalctl -u hubd -n 20 --no-pager                           # listening, no errors
# verify: a work write with a paired token (hubd pair --kind console ... ) returns 201 and the file appears
curl -s -X POST http://<bind>:3150/v1/work -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"kind":"idea","domain":"<domain>","title":"hub-writes check","assignee":"1uk4"}'
ls -l /home/wolf-W1hOrJ/knowledge/base/domains/<domain>/work | tail -3
```
**Roll back:** `/opt/wolfpack-hubd/setup.sh setup` (no flag; same --bind/--port) removes the drop-in, then `systemctl daemon-reload && systemctl restart hubd`; writes return `work_store_read_only` again and items already written stay on disk. To also undo the permissions on each work dir: `chgrp root <dir> && chmod 755 <dir>` (ACL path: `setfacl -b <dir>`). To remove the group: `gpasswd -d hubd wolfpack-work` (and for each --work-user), then `groupdel wolfpack-work` once no dir uses it. Items hubd wrote stay owned by `hubd`; `chown` them if Dewey must edit them in place.
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
ss -ltnp | grep -E ':(3141|3150)\b'                   # 3141 must be empty (agent retired 2026-11-06); 3150 free before first start
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
`WOLFPACK_KB_WRITER=1` (in `hubd.env`, from `hubd.env.example`) turns off the worker-mirror write guard (`@wolfpack/kb` mirror-guard): hubd (and, until its retirement on 2026-11-06, the sfo-01 `wolfpack-agent`) writes the KB tree on purpose. Never set it on Mac workers.
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
systemctl is-active wolf-W1hOrJ                                     # unchanged (wolfpack-agent retired 2026-11-06; expect inactive/disabled)
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

## 5b. Pair a phone or laptop, revoke a device (P2)
Each device gets its own revocable `browser` token. Set `HUBD_PUBLIC_URL` (hubd.env or the shell running `hubd pair`) to the base URL the PHONE reaches the hub at, including any prefix, e.g. `https://sfo-01.<tailnet>.ts.net/hub`; set `HUBD_CONSOLE_URL` on the serve side so the hub's `/pair` page hands the token to the console (`<console>/pair#token=...`; the fragment never reaches a server or a log).
```
runuser -u hubd -- /usr/bin/node /opt/wolfpack-hubd/current/hubd.mjs pair --kind browser --label "Luka iPhone" --data-dir /var/lib/hubd
```
It prints a QR code and the plain link `<HUBD_PUBLIC_URL>/pair?code=<one-time code>`. Scan it (or open the link), tap Pair. The code is single-use and expires after 10 minutes; `--label` names the device (default `Browser <date>`) and shows in `hubd tokens list` with kind `browser`, `lastUsed`. `--url` overrides `HUBD_PUBLIC_URL` for one call. The code is a secret until used: do not paste the QR into chats. The hub's pairing page posts to the relative path `v1/pair`, so it works behind a proxy that strips `/hub`.
Revoke a lost device (effective on its next request; open event streams are closed):
```
runuser -u hubd -- /usr/bin/node /opt/wolfpack-hubd/current/hubd.mjs tokens list --data-dir /var/lib/hubd
runuser -u hubd -- /usr/bin/node /opt/wolfpack-hubd/current/hubd.mjs tokens revoke tok-xxxxxxxxxx --data-dir /var/lib/hubd
```
**Pair rate limit and the proxy:** failed exchanges are limited per socket peer address (10 failures per minute, then 429). Behind `tailscale serve` (or any local reverse proxy) every request arrives from 127.0.0.1, so the bucket is GLOBAL: someone guessing codes can lock out your own pairing for a minute. Codes are 96-bit random, so guessing is not a real risk; just retry after a minute. `X-Forwarded-For` / `Tailscale-User-Login` are deliberately not trusted (no trusted-proxy flag yet).
The hub warns at startup when `HUBD_CONSOLE_URL` is plain http on a non-loopback host.
The console forwards each browser's own token verbatim; its own `WOLFPACK_HUB_TOKEN` is used only by `GET /api/health`. A browser without (or with a revoked) token gets 401 and is sent to `/pair`.

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

## 7. Merge the legacy work store into hubd (`hubd work-import`, ticket work-wolfpack-MMeb8jJ)
Until the old wolves are repointed to the hub, work is written in two places: hubd's store (`/var/lib/hubd/ledger/work-events.jsonl` + the work dirs behind the `kb/base/domains` symlink) and the legacy store (`/var/lib/workerd-kb/domains/<d>/work/*.md` + `/var/wolfpack/kb/work/ledger/work-events.jsonl`, written by the legacy wolfpack-agent, retired 2026-11-06; the store is archived at `/root/archive-work-20261106`, so no new legacy writes). `work-import` merges legacy into hubd; the legacy paths are only read. What it does:
- **Ledger:** legacy migration duplicates are collapsed first (exact copies; the same note text on the same item, first one kept; an event equal to the previous one of the item ignoring `at`; a `staged` to the stage the item already has; a stage change is never dropped; an item whose folded state would change is kept whole). The result is diffed against hubd's ledger (sha256 of the canonical event, as a multiset) and the missing events are merged in: each source keeps its own order, the heads are compared by `at`, hubd's 5+ events are never touched or reordered. Events with a non-date `at` are skipped and counted (they would make the fold throw).
- **Files:** legacy-only `.md` are copied; for items in both, the file with the newer effective `updated` wins (tie: the one matching the merged ledger's stage, else hubd's is kept and listed as a conflict); hubd-only files are never deleted.
- **Seed:** a file whose id the merged ledger never mentions gets synthetic events (`by: hubd-work-import-seed`) so hubd's ledger-only write path knows it. On the 2026-11-03 data this is 0 items (the legacy ledger already covers all 459 hubd-only files), the step is a safety net. A file whose id is in the ledger (even deleted) is never seeded.
- It takes the work-writer lock (even for `--dry-run`), so it **refuses while hubd runs**. Run it as the `hubd` user so new files get the right owner. Unreadable files abort the run; malformed ones are skipped and counted. A dry run writes exactly one file, the list of dropped duplicates (`/var/lib/hubd/backups/work-import-dryrun-<stamp>-dropped.tsv`); a real run puts it in its backup dir (`dropped-duplicates.tsv`).
All commands on sfo-01 as root:
```
N="runuser -u hubd -- /usr/bin/node /opt/wolfpack-hubd/current/hubd.mjs"
LEG_L=/var/wolfpack/kb/work/ledger/work-events.jsonl; LEG_D=/var/lib/workerd-kb/domains
ARGS="--from-domains $LEG_D --from-ledger $LEG_L --data-dir /var/lib/hubd --domains personal,wolfpack"

# 0. read-access pre-checks AS hubd (a permission problem aborts the import anyway; find it first)
runuser -u hubd -- test -r $LEG_L && echo ledger readable
runuser -u hubd -- ls $LEG_D/wolfpack/work $LEG_D/personal/work >/dev/null && echo work dirs readable

# 1. stop hubd
systemctl stop hubd

# 2. back up. The tar of /var/lib/hubd holds only the kb/base/domains SYMLINK, so also copy the real work dirs and the ledger
B=/root/hubd-pre-work-import-$(date +%Y%m%d-%H%M%S); mkdir -p "$B"
( umask 077; tar --one-file-system -C /var/lib -cpf "$B/hubd-state.tar" hubd )
for d in personal wolfpack; do mkdir -p "$B/work/$d"; cp -a /var/lib/hubd/kb/base/domains/$d/work/. "$B/work/$d/"; done   # cp follows the symlink
ls "$B/work/wolfpack" | wc -l                                                          # expect ~484 (before import)
# (the import also makes its own copy under /var/lib/hubd/backups/work-import-<stamp>/ before writing)

# 3. dry run: writes nothing but the dropped-duplicates list
$N work-import $ARGS --dry-run
# expected on the 2026-11-03 data:
#   legacy events in scope: 3926; after collapsing migration duplicates: 3824 (dropped: exact 58, note 43, adjacent 0, noop-stage 1)
#   dedupe check ...: 0 difference(s)
#   events to append: 3824      0 events out of scope      files to add: 46      files to update: 22      conflicts ...: 1
#   seed: 0 events for 0 file-only items      malformed ledger lines: 0      skipped files: 0      items bound ... : 0
# (numbers move a little if the legacy wolves wrote since; skipped files must be 0, a non-zero value names the file)

# 4. import. The consistency check compares the ledger-only fold (what hubd writes see) with every work file on stage, title, assignee, partOf, graduated and log length
$N work-import $ARGS                       # expect: consistency check: ~530 files, 0 mismatch(es)

# 4b. idempotence: a second run, hubd still stopped, must show events to append: 0 / files to add: 0 / files to update: 0
$N work-import $ARGS --dry-run | grep -E "^(events|files)"

# 5. start hubd
systemctl start hubd

# 6. checks
systemctl is-active hubd; journalctl -u hubd -n 20 --no-pager
wc -l /var/lib/hubd/ledger/work-events.jsonl      # 5 + 3824 = 3829 (+ seed events, if any)
ls /var/lib/hubd/kb/base/domains/wolfpack/work/*.md | wc -l   # ~530 (484 + 46)
# through the console/API: work-wolfpack-0HuY8Al is a shipped feature with its ~17 children; a PATCH (note/stage) to a formerly file-only item returns 200, not 404; the 38 items the legacy ledger deleted are not listed
```

**Rollback** (only valid BEFORE hubd takes new writes; after that, writes made since would be lost). With hubd stopped:
```
systemctl stop hubd
ls /var/lib/hubd/backups                                   # the import's own backup: work-import-<stamp>/ (ledger/ + kb/base/domains/<d>/work/)
S=/var/lib/hubd/backups/work-import-<stamp>                # fill in the stamp
cp -p $S/ledger/work-events.jsonl /var/lib/hubd/ledger/work-events.jsonl                 # the pre-import ledger (5 events)
for d in personal wolfpack; do
  W=/var/lib/hubd/kb/base/domains/$d/work
  cp -a "$B/work/$d/." "$W/"                                # restore replaced files (and anything else that was there)
  for f in "$W"/*.md; do [ -e "$B/work/$d/$(basename "$f")" ] || rm -v -- "$f"; done   # remove files the import ADDED (not in the pre-import copy)
done
systemctl start hubd
```
(`cp -a` keeps owners and modes. The tar in `$B` is the full-state fallback.)

**Catch-up re-run** (until the old wolves are repointed; the legacy writer stays live): repeat steps 0-5 with a fresh backup in step 2. Only events and files that are new or newer in legacy are applied; events already imported, and the duplicates the collapse dropped, are not re-added, and writes made through hubd are never lost (its ledger is only added to). A few `MISMATCH` lines right after an import while legacy is live just mean "re-run". On a catch-up run a `MISMATCH` can also be legitimate: an item hubd has advanced since (its ledger is ahead of its file, or a kept hubd file is ahead of the legacy ledger) differs from its file by design; check that the ledger side is the newer one.

**Crash mid-run:** safe to re-run. Files are written first (each tmp + rename, tmp files are removed on error), the ledger last (tmp + rename), and every step is idempotent. A leftover `.<pid>.<ts>.import.tmp` in a work dir after a hard kill can be deleted.

## 8. Hub curator: KB curation inside hubd (ticket work-wolfpack-tPBXKuJ). NOT deployed; default OFF
hubd can run the KB sweep itself (`packages/hubd/src/curator.ts`): `runSweepTick` on the lane `<data-dir>/kb/ops/contributions`, entries / `_registry.md` / `_digest.json` / `INDEX.md` written through `commitKb` (actor `system`, under the KB writer lock; the lock is held only around each write, never during a model or embedding call), the other KB files (ledger events, `_sections.json`, entry versions, Delivered-list rewrites) inside the same writer queue, receipts into `<data-dir>/kb/ops/receipts/<wolf>/` (the link relays them back), handled files into `_processed/`. Events on `/v1/events`: `sweep_started`, `sweep_item`, `sweep_finished` (always paired, `error` on a failed tick), plus `kb.changed` per commit. A failed commit (conflict, engine error) leaves the item in the lane with no receipt; the sweep's normal attempt counting then parks it after 3 tries. No `git commit` is made (the hub KB is not a repo).

Env (`hubd.env.example`): `HUBD_CURATOR` (default 0), `HUBD_CURATOR_POLL_MS` (60000; 0 = no timer), `HUBD_CURATOR_MODELS` (models.json path), `HUBD_EMBED_URL` / `HUBD_EMBED_MODEL`.

**Exclusion:** `<lane>/.sweep-lease` (`{owner, pid, host, at}`, O_EXCL, mtime heartbeat; stale after 2 x the tick budget or when the pid is dead on the same host). The hub takes it while the curator is on. hubd refuses to start (and skips a tick) while a fresh WOLF lease exists; a wolf-side `runSweepTick` (Dewey's timer, `kb sweep`) skips silently while the hub lease is fresh and holds a wolf lease while it runs. Dotfiles in a lane are never read as contributions.

**Startup refuses** when `HUBD_INBOX_ROOT` / `HUBD_RECEIPTS_ROOT` are set to anything but the hub defaults, or in `hubd dev`.

**Lease details and limits.**
- The lease file is published whole (temp file + `link`), never empty; an unparseable one counts as HELD for 10 s after its mtime, then as stale. A stale lease is taken over under a mutex (`.sweep-lease.takeover`), so two takers cannot both win.
- Staleness assumes ONE host and ONE clock: age is mtime vs. `Date.now()` and the dead-pid shortcut applies only when the lease's hostname is this host. `.sweep-lease*` must never be synced: add `.sweep-lease*` to the Syncthing ignores of any folder that contains a KB lane (`kb/ops/inbox`, `kb/ops/contributions`). The repo ships no ignore rules for the KB itself (add-wolf.sh copies `roles/workspace/files/stignore`, which is not in the tree), so check the live `.stignore` files by hand.
- **Restart after a crash:** a lease left by the crashed hubd is cleared at once only when its pid is dead on this host. systemd normally restarts hubd with a new pid; the old lease is then dead-pid stale and taken. A lease from a LIVE other pid or from another hostname (a restored copy, a second hubd, a wolf sweep) blocks the start with `could not take the sweep lease` until it is 2 x the tick budget old (about 40 minutes), or until you remove `<data-dir>/kb/ops/contributions/.sweep-lease` by hand after checking nobody sweeps.
- The lease covers the two kinds of SWEEP only. `kb reorg`, rebuild, retire, split-fat and the sweep's tryRecoverAndRender are NOT covered: they take only the den-local KB lock and write the KB directly, bypassing `commitKb`. Do not run them against the hub's KB while the hub is live.
- **Leftovers:** a crash can leave `.sweep-lease.<pid>.<hex>` and `.sweep-lease.takeover*` files in the lane directory. They are harmless (dotfiles are never read as contributions) and safe to delete; a stale `.sweep-lease.takeover` clears itself after 60 s.
- **Shutdown:** `close()` stops the timer and refuses writes that would OPEN a new item (a new entry commit, a patch, a quarantine, a reject receipt, a duplicate move) while an item that already committed is allowed to finish (its ledger append, Delivered sync, receipt and `_processed` move), so a routine restart never leaves a live entry whose contribution is unseen. It waits up to 15 s (under `TimeoutStopSec=20`), and keeps the lease until that tick has ended.
- **Commit intent (closes the old commit→append window, work-wolfpack-hHgbann / work-wolfpack-2rZ14NO):** before it commits an entry, sweep.ts writes `<dataDir>/kb/ops/pending-commit.json` (hash, entry, the exact ledger events, digests of the entry before and after the commit) and removes it after the ledger append. A crash or restart in between leaves the file; the next tick replays it under the sweep lease before it drains the lane: the events are appended if the entry is on disk as the commit wrote it (or was rewritten since, which is logged), and the file is discarded, with a log line, if the hash is already seen or the commit never landed. A corrupt or invalid file is renamed to `pending-commit.json.corrupt-<ts>`. If the replay's append itself fails, the file stays and the tick is blocked (log line `BLOCKED: could not replay the pending commit intent`) until the ledger is writable; fix that, no manual step. The file is in `kb/ops`, so it is not exported or synced. A twin-entry check after a crash is no longer needed; a `.corrupt-` file or a `discarded` log line is worth a look.

### Cutover (owner steps on sfo-01, in this order; first run for real 2026-11-05/06, ticket work-wolfpack-cd7SyRt)
`<dewey-wolf>` = Dewey's wolf user (sfo-01: `wolf-W1hOrJ`). Check each write before the next. Before anything: `cp -a /etc/wolfpack/hubd.env /etc/wolfpack/hubd.env.bak-<date>`, `cp -a /var/lib/hubd/ledger /var/lib/hubd/ledger.bak-<date>` (hubd stopped for the copy, or accept a tiny race), and note the current drop-ins in `/etc/systemd/system/hubd.service.d/`.

1. Stop Dewey's sweep so only the hub sweeps: stop the librarian wolf's sweep timer (or the whole wolf) and any `kb sweep` cron. Let it finish its tick first (`ls /home/<dewey-wolf>/librarian/inbox/*/` must be empty or you accept those items staying for Dewey). Re-run the final `hubd kb-backfill` (contributions/entries/decisions) before any curator write.
2. **Make the KB the hub's, as a real directory (not a symlink into Dewey's home).** `/var/lib/hubd/kb/base/domains` is a symlink to Dewey's tree and the unit binds it read-only. With hubd stopped:
   ```
   cd /var/lib/hubd/kb/base
   mv domains domains.dewey-link-<date>          # keep the symlink for rollback
   mkdir domains
   rsync -a /home/<dewey-wolf>/knowledge/base/domains/ domains/
   chown -R hubd:hubd domains
   for d in domains/*/ domains.dewey-link-<date>/*/; do echo "$d $(ls $d/entries | wc -l)"; done   # per-domain entry counts must match before/after
   ```
3. **Copy Dewey's section tree BEFORE enabling the curator.** Dewey's tree is `/home/<dewey-wolf>/den/kb/sections/_sections.json`; the curator reads `<dataDir>/sections/_sections.json`. If it is missing the curator starts with an empty tree, invents junk top-level sections named after entry summaries, and the domain `_digest.json` collapses.
   ```
   install -d -o hubd -g hubd /var/lib/hubd/sections
   install -o hubd -g hubd -m 640 /home/<dewey-wolf>/den/kb/sections/_sections.json /var/lib/hubd/sections/_sections.json
   ```
   Recovery if missed: `hubd kb-rehome --data-dir /var/lib/hubd --move <entryId>=<sectionId> ... --remove-section <id> ... [--apply]` (dry run by default; hubd MUST be stopped: it needs the KB writer lock and the sweep lease). Do the alias backfill (step 4) before any rehome.
4. **Copy Dewey's topic links (aliases) and retire records.** The earlier `hubd kb-backfill` writes only contribution / entry_written / decision events. Without Dewey's `aliased` and `entry_retired` events a re-promoted topic is routed by similarity and can duplicate, and `_registry.md` renders empty alias lists. With hubd stopped and `ledger/` backed up (above):
   ```
   cp /home/<dewey-wolf>/den/kb/ledger/events.jsonl /root/dewey-events.<date>.jsonl
   hubd kb-backfill --aliases --dewey-ledger /root/dewey-events.<date>.jsonl --data-dir /var/lib/hubd --dry-run
   hubd kb-backfill --aliases --dewey-ledger /root/dewey-events.<date>.jsonl --data-dir /var/lib/hubd
   ```
   It skips keys the hub curator already aliased and retires for entries the curator rewrote; idempotent. It must run BEFORE any kb-rehome (rehome's writes count as curator writes for the skip rule). The dry run will list alias targets with no file and no survivor (entries the owner retired): harmless. Other files in Dewey's `den/kb` (`sweep-attempts.json`, `split-cache.json`, `emitted*`, `work-links.jsonl`, vectors) need no copying.
5. **Unit: remove ALL `/home` binds at once.** Removing only some of `BindReadOnlyPaths=` / `BindPaths=` / `ReadWritePaths=` into Dewey's home makes hubd fail with `226/NAMESPACE` ("Failed to set up mount namespacing: .../librarian/inbox: No such file or directory"). Use a drop-in (sfo-01: `/etc/systemd/system/hubd.service.d/curator-local.conf`):
   ```
   [Service]
   BindReadOnlyPaths=
   BindPaths=
   ReadWritePaths=
   ReadWritePaths=/var/lib/hubd
   ```
   Disable the old work-writes drop-in by renaming it (e.g. `mv work-writes.conf work-writes.conf.off-<date>`; not `.conf~`). Then `systemctl daemon-reload` (do not restart yet).
6. **Model access for user `hubd`, tested in the sandbox first.** Put a copy of Dewey's models.json at e.g. `/etc/wolfpack/curator-models.json` (`root:hubd`, 640). The Claude Agent SDK comes from the host's global install (`/usr/lib/node_modules/@anthropic-ai/claude-agent-sdk`); the sandbox must resolve it. Test with a transient unit carrying the same properties before touching the live hub (hubd stopped or on other paths; use the unit's `User=`, `EnvironmentFile=`, `ProtectHome`/`ProtectSystem` and `ReadWritePaths=/var/lib/hubd` as in `systemctl cat hubd`):
   ```
   systemd-run --wait --pipe -p User=hubd -p EnvironmentFile=/etc/wolfpack/hubd.env -p ProtectSystem=strict -p ProtectHome=yes -p ReadWritePaths=/var/lib/hubd \
     /bin/sh -c '<check>'
   ```
   `<check>` covers: (a) `node -e "require.resolve(\"@anthropic-ai/claude-agent-sdk\")"` resolves (set `NODE_PATH=/usr/lib/node_modules` if needed); (b) Ollama embeddings: POST to `$HUBD_EMBED_URL` with `$HUBD_EMBED_MODEL` (`nomic-embed-text`) returns a 768-dim vector; (c) a one-shot haiku call through the SDK with `CLAUDE_CODE_OAUTH_TOKEN` succeeds; (d) `/var/lib/hubd/kb` and `sections` are writable. Check `RestrictAddressFamilies`/`SystemCallFilter` still allow the engine.
7. **Env** in `/etc/wolfpack/hubd.env` (backup taken above; names only here): set `HUBD_CURATOR=1`, `HUBD_CURATOR_POLL_MS`, `HUBD_CURATOR_MODELS` (the path from step 6), `HUBD_EMBED_URL`, `HUBD_EMBED_MODEL`, `CLAUDE_CODE_OAUTH_TOKEN` (the subscription token; never echo it). REMOVE `HUBD_INBOX_ROOT` and `HUBD_RECEIPTS_ROOT` (startup refuses otherwise). Workers keep contributing over the link; files already in Dewey's inbox are NOT migrated (drain them first, step 1).
8. Install the new bundle if not yet (`setup.sh install`), `systemctl restart hubd`. Check `systemctl status hubd`, `journalctl -u hubd -f` for `[curator]` lines, and `ls /var/lib/hubd/kb/ops/contributions/.sweep-lease`. **The first tick can take ~4 min** (cold vector cache); do not restart during it.
9. Verify: push one test contribution (a worker `contribute`); see `sweep_started` -> `sweep_item` -> `sweep_finished` and `kb.changed` on `/v1/events`, the entry under `kb/base/domains/<d>/entries/`, the receipt in the worker, and the item (incoming, in progress, then decided) on `/v1/kb/activity` and the console's /kb-activity page, without any backfill. Re-compare per-domain entry counts and check `<domain>/_digest.json` still has the real section tree (no junk top-level sections) and `_registry.md` shows alias lists.

**Roll back:** (all with hubd stopped where noted)
1. `systemctl stop hubd`.
2. Env: restore `/etc/wolfpack/hubd.env` from the backup (this also drops `HUBD_CURATOR=1` and restores the two lane vars).
3. Unit: remove `curator-local.conf`, rename the old work-writes drop-in back, `systemctl daemon-reload`.
4. KB: `cd /var/lib/hubd/kb/base; mv domains domains.hub-<date>; mv domains.dewey-link-<date> domains` (entries the curator wrote live only in `domains.hub-<date>`; copy back what you need).
5. Ledger: restore the backed-up `ledger/` dir (`mv ledger ledger.bad; cp -a ledger.bak-<date> ledger`). `sections/` may stay.
6. `systemctl start hubd`; re-enable and start the Dewey wolf unit / sweep timer. If you only need to pause the curator without the full revert: set `HUBD_CURATOR=0`, restart hubd (the lease is removed on a clean stop; a stale one is ignored after 2 x the tick budget or when its pid is gone), restart Dewey's sweep; entries the curator wrote stay.

`setup.sh --dry-run setup --curator` prints the env and unit changes above as `DRY-RUN:` lines. Without `--dry-run` it refuses: the cutover is an owner step.
