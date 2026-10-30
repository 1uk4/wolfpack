# workerd (link and KB sync only) on sfo-01, serving wolf Hal (ticket work-wolfpack-1Vob0Gh, part B)

Prepared, NOT yet run. Run only after owner confirmation. Never print `/etc/wolfpack/workerd.env`, `/var/lib/workerd/hub.json` or tokens.

## Target state
| | |
|---|---|
| mode | `workerd --link-only` (`WORKERD_LINK_ONLY=1`): hub link + KB sync + announces wolf `hal`. It supervises and spawns **no** wolfd (`packages/workerd/src/run.ts`, `linkOnly`). Hal keeps running from `wolf-ETAy7b.service` |
| user | `workerd` (system, nologin); no access to `/home` (`ProtectHome=yes`) |
| env | `/etc/wolfpack/workerd.env`, root:root 600 (link-only, announce `hal`, `WORKERD_FEED=0`, `WORKERD_KB_LAYOUT=base`, `WORKERD_CONFIG_DIR=/var/lib/workerd`) |
| code | `/opt/wolfpack-workerd/{releases,current,previous}`, `/usr/bin/node` |
| data | `/var/lib/workerd` (0700): `hub.json` (from `workerd pair`), `outbox/`, `ops/`, **`kb-mirror/`** (base layout: `kb-mirror/domains/<d>/…`) |
| HTTP | `127.0.0.1:7142` (cannot be disabled; never 3141 agent, 3150 hubd, 7141 Mac workerd) |
| feed | off: Hal writes contributions straight into Dewey's inbox |

Hal's `.env` (`KB_BASE=/var/wolfpack/kb/base`) is **not** changed. Pointing `KB_BASE` at `/var/lib/workerd/kb-mirror` is a later, owner-approved step (note: that dir would need to be readable by Hal's user, which this sandbox layout does not grant yet). No KB copy is ever deleted by anything here.

The unit starts only when `/var/lib/workerd/hub.json` exists. `setup.sh` fails the preflight (`WOULD FAIL` in dry-run) if the env would not be link-only, announces nothing, has the feed on, a non-loopback bind, a bad port (3141, 3150, 7141, out of range) or any foreign listener on the port, or if the unit's `ExecStart` lacks `--link-only` or mentions `wolfd`. The unit repeats the guards in `ExecStartPre`.

## A. Build the bundle (Mac)
```
npm ci && npx tsc --build
node deploy/workerd/build-bundle.mjs /tmp/workerd-bundle     # prints the sha256 of workerd.mjs
node /tmp/workerd-bundle/workerd.mjs --help | head -2         # expect "usage:"
```
## B. Preflight (read-only on sfo-01, ssh as in ops.md)
```
node --version; command -v node; ss -ltnp | grep -E ':(3141|3150|7141|7142)\b'   # 3141 agent and 3150 hubd only
systemctl is-active wolf-ETAy7b; pgrep -u wolf-ETAy7b -fc . ; id workerd          # record Hal's state; workerd absent on first run
```
## C. Stage (Mac)
```
S="ssh -i ~/.ssh/wolfpack -o IdentitiesOnly=yes -o IdentityAgent=none"
$S root@100.120.154.69 'mkdir -p /root/workerd-stage/bundle /root/workerd-stage/deploy'
rsync -a --delete -e "$S" /tmp/workerd-bundle/ root@100.120.154.69:/root/workerd-stage/bundle/
rsync -a --delete -e "$S" deploy/workerd/ root@100.120.154.69:/root/workerd-stage/deploy/
```
## D. Dry run (sfo-01, root)
```
cd /root/workerd-stage/deploy
./setup.sh --dry-run setup --announce hal --port 7142
./setup.sh --dry-run install --bundle /root/workerd-stage/bundle
```
Resolve every `WOULD FAIL` line first. If `/etc/wolfpack/workerd.env` already exists, its `WORKERD_PORT` and `WORKERD_ANNOUNCE` win and `--port`/`--announce` are ignored (setup prints a NOTICE).
## E. Install (sfo-01, root); the service is enabled but not started yet
```
./setup.sh setup --announce hal --port 7142
./setup.sh install --bundle /root/workerd-stage/bundle
```
Sandbox smoke test (same properties as the unit; node must not crash on `os.networkInterfaces()`, which needs AF_NETLINK):
```
systemd-run --wait --pipe -p User=workerd -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes \
  -p RestrictAddressFamilies="AF_INET AF_INET6 AF_UNIX AF_NETLINK" -p CapabilityBoundingSet= -p SystemCallFilter=@system-service -p SystemCallErrorNumber=EPERM \
  /usr/bin/node -e 'require("os").networkInterfaces(); console.log("netif ok")'
```
## F. Register, pair, start (sfo-01, root)
Order: host and wolf on the hub, then pair, then start. The admin token must never appear in argv, so curl reads the header from a process substitution (a bash builtin `printf`; `cat` only reads the file):
```
H=http://100.120.154.69:3150; J='Content-Type: application/json'
hubcurl() { curl -sS -H @<(printf 'Authorization: Bearer %s\n' "$(cat /root/hubd-admin.token)") -H "$J" "$@"; }
hubcurl -X POST $H/v1/registry/hosts  -d '{"name":"sfo-01"}'
hubcurl -X POST $H/v1/registry/wolves -d '{"name":"hal","host":"sfo-01","domains":["personal","snapjack","wolfpack"]}'   # each 201
hubcurl $H/v1/registry/wolves
CODE=$(runuser -u hubd -- /usr/bin/node /opt/wolfpack-hubd/current/hubd.mjs pair --kind worker --host-id sfo-01 --data-dir /var/lib/hubd | sed -n 's/^pairing code: *\([A-Za-z0-9_-]*\).*/\1/p')   # single-use, 10 minutes
[ "${#CODE}" -eq 16 ] || { echo "STOP: pairing code is ${#CODE} chars, expected 16 (base64url); do not continue, read it from the pair output by hand" >&2; false; }
( cd / && runuser -u workerd -- env WORKERD_CONFIG_DIR=/var/lib/workerd /usr/bin/node /opt/wolfpack-workerd/current/workerd.mjs pair http://100.120.154.69:3150 "$CODE" )
test -f /var/lib/workerd/hub.json && echo "hub.json present" || echo "NO hub.json: the unit will NOT start (ConditionPathExists)"
systemctl start workerd; sleep 3; systemctl is-active workerd
```
`systemctl start` returns success even when `ConditionPathExists` skips the unit, so always check `is-active` and `hub.json`. The code is passed to `pair` in argv for a few seconds; it is single-use and expires, unlike the admin token. (If `/root/hubd-admin.token` does not exist, mint a console token as in `deploy/hubd/RUNBOOK.md` §5.) Plain http is accepted inside Tailscale only; workerd prints a warning.

## G. Verify
```
journalctl -u workerd -n 30 --no-pager | grep -E 'link-only|hub link: online \(host sfo-01\)'   # both lines expected
ss -tnpe state established '( dport = :3150 )' | grep -E "users:\(\(\"node\"" | grep "uid:$(id -u workerd)"   # established to :3150 as the workerd uid
ss -ltnp | grep ':7142'                                                                         # 127.0.0.1 only
ps -o user= -p "$(systemctl show -p MainPID --value workerd)"                                   # workerd
pgrep -u workerd -a . | wc -l                                                                   # 1: no wolfd children
ls /var/lib/workerd/kb-mirror/domains; du -sh /var/lib/workerd/kb-mirror                        # fills in (personal, snapjack, wolfpack)
/usr/bin/node /opt/wolfpack-workerd/current/workerd.mjs kb-compare --syncthing /var/wolfpack/kb/base --mirror /var/lib/workerd/kb-mirror --layout base
```
`kb-compare` must report CLEAN. Do not pass `--json` a path inside `/var/lib/workerd` (it would write into the data dir; use `/root/...`). It is read-only (`--syncthing` is only read); run it as root, since the `workerd` user may not be able to read `/var/wolfpack/kb/base`.
Hal unchanged: `systemctl is-active wolf-ETAy7b` as recorded in B; exactly one Hal process (`pgrep -u wolf-ETAy7b -af agent | wc -l`, same as before); `stat -c '%U:%G %a' /etc/wolfpack/workerd.env /var/lib/workerd/hub.json` is `root:root 600` and `workerd:workerd 600`. (A seccomp journal check proves little here: `SystemCallErrorNumber=EPERM` makes filtered calls fail quietly, so rely on the sandbox smoke test in E.)

## Rollback / removal
- Bad release: `./setup.sh rollback` (swaps `current` and `previous`).
- Stop quickly: `systemctl disable --now workerd`. Hal and hubd are unaffected; the hub just sees the host offline.
- Remove: `./setup.sh --dry-run uninstall`, then `./setup.sh uninstall`. Keeps `/var/lib/workerd` (hub.json, mirror), the env file and the user. `uninstall --purge` refuses while any systemd unit or `/home/*/.env` still references `/var/lib/workerd/kb-mirror` (it searches systemd unit dirs, `/etc/wolfpack`, `/var/wolfpack`, `/home/*/.env`, and Hal's `EnvironmentFile=`/`WorkingDirectory=` from `systemctl cat wolf-ETAy7b`; **the guard is best-effort**, so confirm by hand that nothing reads the mirror, and it also refuses in `--dry-run`); otherwise it deletes `/var/lib/workerd` (including the **derived** hub mirror and hub.json) and the user; stop first. It never touches Hal's unit or `.env`, Dewey's tree, or Syncthing/`/var/wolfpack/kb` copies. Revoke the host's token on the hub afterwards if it is gone for good.
