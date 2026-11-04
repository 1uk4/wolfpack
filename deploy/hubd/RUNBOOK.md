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
Until the old wolves are repointed to the hub, work is written in two places: hubd's store (`/var/lib/hubd/ledger/work-events.jsonl` + the work dirs behind the `kb/base/domains` symlink) and the legacy store (`/var/lib/workerd-kb/domains/<d>/work/*.md` + `/var/wolfpack/kb/work/ledger/work-events.jsonl`, written by wolfpack-agent). `work-import` merges legacy into hubd; the legacy paths are only read. What it does:
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
