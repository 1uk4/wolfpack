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
rsync -a --delete -e "$S" /tmp/workerd-bundle/ root@100.120.154.69:/root/workerd-stage/bundle/
rsync -a --delete -e "$S" deploy/workerd/ root@100.120.154.69:/root/workerd-stage/deploy/
```
## D. Dry run (sfo-01, root)
```
cd /root/workerd-stage/deploy
./setup.sh --dry-run setup --announce hal --port 7142
./setup.sh --dry-run install --bundle /root/workerd-stage/bundle
```
Resolve every `WOULD FAIL` line first.
## E. Install (sfo-01, root); the service is enabled but not started yet
```
./setup.sh setup --announce hal --port 7142
./setup.sh install --bundle /root/workerd-stage/bundle
```
## G. Register and pair (sfo-01, root), then start
Order: host and wolf on the hub, then pair, then start. Use a console token (hubd's `/root/hubd-admin.token`; never echo it):
```
H=http://100.120.154.69:3150; A="Authorization: Bearer $(cat /root/hubd-admin.token)"; J='Content-Type: application/json'
curl -sS -H "$A" -H "$J" -X POST $H/v1/registry/hosts  -d '{"name":"sfo-01"}'
curl -sS -H "$A" -H "$J" -X POST $H/v1/registry/wolves -d '{"name":"hal","host":"sfo-01","domains":["personal","snapjack","wolfpack"]}'   # each 201
curl -sS -H "$A" $H/v1/registry/wolves
CODE=$(runuser -u hubd -- /usr/bin/node /opt/wolfpack-hubd/current/hubd.mjs pair --kind worker --host-id sfo-01 --data-dir /var/lib/hubd)   # single-use, 10 minutes; take the code from the output
runuser -u workerd -- env WORKERD_CONFIG_DIR=/var/lib/workerd /usr/bin/node /opt/wolfpack-workerd/current/workerd.mjs pair http://100.120.154.69:3150 <code>
systemctl start workerd
```
(If `/root/hubd-admin.token` does not exist, mint a console token as in `deploy/hubd/RUNBOOK.md` §5.) Plain http is accepted inside Tailscale only; workerd prints a warning.

## F. Verify
```
journalctl -u workerd -n 30 --no-pager | grep -E 'link-only|hub link: online \(host sfo-01\)'   # both lines expected
ss -tnp state established '( dport = :3150 )' | grep workerd/node                              # established to :3150
ss -ltnp | grep ':7142'                                                                        # 127.0.0.1 only
ps -o user= -p "$(systemctl show -p MainPID --value workerd)"                                  # workerd
pgrep -u workerd -a . | wc -l                                                                  # one process: no wolfd children
ls /var/lib/workerd/kb-mirror/domains; du -sh /var/lib/workerd/kb-mirror                       # fills in (personal, snapjack, wolfpack)
runuser -u workerd -- env WORKERD_CONFIG_DIR=/var/lib/workerd /usr/bin/node /opt/wolfpack-workerd/current/workerd.mjs kb-compare --syncthing /var/wolfpack/kb/base --mirror /var/lib/workerd/kb-mirror --layout base
```
`kb-compare` must report CLEAN. If the `workerd` user cannot read `/var/wolfpack/kb/base`, run it as root instead (it is read-only; `--syncthing` is only read, never written):
`/usr/bin/node /opt/wolfpack-workerd/current/workerd.mjs kb-compare --syncthing /var/wolfpack/kb/base --mirror /var/lib/workerd/kb-mirror --layout base`.
Hal unchanged: `systemctl is-active wolf-ETAy7b` as recorded in B; exactly one Hal process (`pgrep -u wolf-ETAy7b -af agent | wc -l` same as before); `journalctl -k | grep -i seccomp` has nothing about workerd; `stat -c '%U:%G %a' /etc/wolfpack/workerd.env /var/lib/workerd/hub.json` is `root:root 600` and `workerd:workerd 600`.

## Rollback / removal
- Bad release: `./setup.sh rollback` (swaps `current` and `previous`).
- Stop quickly: `systemctl disable --now workerd`. Hal and hubd are unaffected; the hub just sees the host offline.
- Remove: `./setup.sh --dry-run uninstall`, then `./setup.sh uninstall`. Keeps `/var/lib/workerd` (hub.json, mirror), the env file and the user. `uninstall --purge` also deletes `/var/lib/workerd` (including the **derived** hub mirror and hub.json) and the user; stop first. It never touches Hal's unit or `.env`, Dewey's tree, or Syncthing/`/var/wolfpack/kb` copies. Revoke the host's token on the hub afterwards if it is gone for good.
