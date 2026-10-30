# Deploy hubd on sfo-01 (ticket work-wolfpack-gctZOIO)

Prepared, NOT yet run. Everything below needs owner confirmation first. Never print `/etc/wolfpack/hubd.env` or tokens.

## Target state
| | |
|---|---|
| user / group | `hubd` / `hubd` (system, nologin). Never `wolf-W1hOrJ` (Dewey) |
| bind | Tailscale IP `100.120.154.69` only (loopback also fine), port **3150** (3141 = wolfpack-agent) |
| unit | `/etc/systemd/system/hubd.service`, `After=tailscaled`, `Restart=on-failure`, hardened (see file) |
| env | `/etc/wolfpack/hubd.env`, root:root 600 |
| code | `/opt/wolfpack-hubd/releases/<ts>-<sha>/hubd.mjs`, symlinks `current` and `previous` |
| data | `/var/lib/hubd` (hubd 0700): ledger, registry, auth tokens, `kb/base`, `kb/ops` |
| KB read | `/var/lib/hubd/kb/base/domains` → symlink to `/home/wolf-W1hOrJ/knowledge/base/domains`; ACL `u:hubd:rX` + default ACL |
| inbox write | ACL `u:hubd:rwX` + default ACLs (hubd and Dewey) on `/home/wolf-W1hOrJ/librarian/{inbox,receipts}`; `--x` on `/home/wolf-W1hOrJ`, `knowledge`, `knowledge/base`, `librarian` |

Why `kb/base` is a hub-owned dir and not a symlink to Dewey's `knowledge/base`: hubd regenerates `<kbBase>/domains.yaml` on every registry write and would overwrite Dewey's file. Only `domains/` is shared.

### KB write access for hub commits (ticket 5) — proposal
Hub KB commits write under `kb/base/domains/<d>/…`, i.e. into Dewey's tree. Default is read-only. Proposal: leave read-only now (reads, pairing, registry, link all work); when the hub becomes the KB's writer, run `setup.sh setup --kb-write` (ACL `rwX` + default on `domains/` only) AND stop Dewey's sweep writing the same tree, or the two writers race (hubd's KB writer lock does not cover Dewey). Until then, treat KB commit endpoints as unsupported on sfo-01.

Contributions today go to `/var/lib/hubd/kb/ops/contributions/<wolf>/` (hubd's own lane). Pointing them at Dewey's inbox/receipts needs ticket 7's config; env names are TBD (`HUBD_INBOX_ROOT`, `HUBD_RECEIPTS_ROOT` commented in `hubd.env.example`). The ACLs and unit binds for those paths are already in place so ticket 7 needs no host change.

## 0. Build (on the Mac, from the repo)
```
npm ci && npx tsc --build
node deploy/hubd/build-bundle.mjs /tmp/hubd-bundle        # prints sha256 of hubd.mjs
```
## 1. Preflight (read-only, over ssh as in ops.md)
```
ssh ... root@100.120.154.69 '
  node --version                          # >= 22
  command -v setfacl || echo "need: apt-get install -y acl"
  tailscale ip -4; systemctl is-active tailscaled
  ss -ltnp | grep -E ":(3141|3150)\b"      # 3150 must be free
  id hubd 2>&1 | head -1                   # absent on first run
  ls -ld /home/wolf-W1hOrJ /home/wolf-W1hOrJ/knowledge/base/domains /home/wolf-W1hOrJ/librarian/{inbox,receipts}
  df -h /var/lib /opt | tail -2'
```
Check the filesystem under `/home` supports ACLs (`setfacl` on ext4/xfs works by default).

## 2. Copy to the host (staging only, nothing live changes)
```
rsync -a --delete -e "ssh -i ~/.ssh/wolfpack -o IdentitiesOnly=yes -o IdentityAgent=none" /tmp/hubd-bundle/ root@100.120.154.69:/root/hubd-stage/bundle/
rsync -a -e "..." deploy/hubd/ root@100.120.154.69:/root/hubd-stage/deploy/   # setup.sh, hubd.service, hubd.env.example
```
## 3. Dry run, then real (on the host, as root)
```
cd /root/hubd-stage/deploy
./setup.sh --dry-run setup
./setup.sh --dry-run install --bundle /root/hubd-stage/bundle
# review output, then:
./setup.sh setup
./setup.sh install --bundle /root/hubd-stage/bundle
systemctl start hubd
```
`setup` is idempotent (existing env file is kept; unit is rewritten). `install` smoke-tests the bundle before flipping `current`, restarts hubd only if already running, keeps 5 releases.

## 4. Verify
```
systemctl is-active hubd; journalctl -u hubd -n 30 --no-pager          # "hubd listening on http://100.120.154.69:3150"
ss -ltnp | grep hubd                      # ONLY 100.120.154.69:3150 (no 0.0.0.0, no *)
ps -o user= -p "$(systemctl show -p MainPID --value hubd)"              # hubd, not wolf-W1hOrJ
stat -c '%U:%G %a' /etc/wolfpack/hubd.env                               # root:root 600
curl -s -o /dev/null -w '%{http_code}\n' http://100.120.154.69:3150/v1/registry/wolves   # 401 = up and enforcing tokens (hubd has no unauthenticated health route)
curl -s -m 3 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3150/v1/registry/wolves   # must fail (000): not bound on loopback
# ACLs, as the hubd user:
sudo -u hubd test -r /home/wolf-W1hOrJ/knowledge/base/domains && echo kb-read ok
sudo -u hubd test -x /home/wolf-W1hOrJ/knowledge/base/domains && echo kb-traverse ok
sudo -u hubd test -w /home/wolf-W1hOrJ/librarian/inbox && echo inbox-write ok
sudo -u hubd test -w /home/wolf-W1hOrJ/librarian/receipts && echo receipts-write ok
sudo -u hubd test ! -w /home/wolf-W1hOrJ/knowledge/base/domains && echo kb-readonly ok   # expected unless --kb-write
sudo -u hubd test ! -r /home/wolf-W1hOrJ/.env && echo secrets-unreadable ok
getfacl -p /home/wolf-W1hOrJ/librarian/inbox
systemctl is-active wolf-W1hOrJ wolfpack-agent                          # unchanged
```
Write test with default ACL (creates and removes one file; Dewey must be able to read it):
```
sudo -u hubd sh -c 'f=/home/wolf-W1hOrJ/librarian/inbox/.hubd-acl-probe; : > "$f"'
sudo -u wolf-W1hOrJ test -r /home/wolf-W1hOrJ/librarian/inbox/.hubd-acl-probe && echo dewey-can-read ok
sudo -u wolf-W1hOrJ rm /home/wolf-W1hOrJ/librarian/inbox/.hubd-acl-probe
```
(If it is bound to the Tailscale IP, check loopback only to confirm refusal; the unit sets no loopback listener.)

## 5. Pair the Mac workerd
On sfo-01 (single-use code, valid 10 minutes). Run as hubd; it takes the token-store lock, safe while hubd runs:
```
sudo -u hubd /usr/bin/env node /opt/wolfpack-hubd/current/hubd.mjs pair --kind worker --host-id <mac-host-id> --data-dir /var/lib/hubd
```
On the Mac, right away:
```
workerd pair http://100.120.154.69:3150 <code>      # stores ~/.wolfpack/workerd/hub.json (0600); plain http is OK only inside Tailscale
```
Pick `<mac-host-id>` as the registry host name (lower-case, e.g. `mac-lukaflores`; confirm with the owner).
Register the host and the wolves before starting workerd (wolves must be pre-registered with their domains; owner-level token needed. Mint one with `pair --kind console`, redeem at `POST /v1/pair`, keep it out of shell history):
```
H=http://100.120.154.69:3150; A="Authorization: Bearer $TOKEN"; J='Content-Type: application/json'
curl -sS -H "$A" -H "$J" -X POST $H/v1/registry/hosts   -d '{"name":"<mac-host-id>"}'
curl -sS -H "$A" -H "$J" -X POST $H/v1/registry/wolves  -d '{"name":"1uk4","host":"<mac-host-id>","domains":["wolfpack","snapjack","personal"]}'
curl -sS -H "$A" $H/v1/registry/wolves
```
(Domains must also exist: `POST /v1/registry/domains`. List the Mac's wolves from `~/wolves/local/*/wolf.yaml`. Names must match the wolf ids workerd announces.)
Then start workerd on the Mac as usual. Online check, either:
- `curl -sN -m 15 -H "$A" $H/v1/events` shows `wolf.presence` events with state `online` for the Mac's wolves (hubd exposes presence on the event stream; there is no GET for it), or
- the console / `journalctl -u hubd` (no `rejected wolves` / `not registered` lines for the Mac's host id).

## 6. Rollback
- Bad release: `./setup.sh rollback` (swaps `current` and `previous`, restarts if active).
- Back out entirely (leaves Dewey and everything else untouched):
```
systemctl disable --now hubd; rm /etc/systemd/system/hubd.service; systemctl daemon-reload
for d in /home/wolf-W1hOrJ /home/wolf-W1hOrJ/knowledge /home/wolf-W1hOrJ/knowledge/base /home/wolf-W1hOrJ/librarian; do setfacl -x u:hubd "$d"; done
setfacl -R -x u:hubd,d:u:hubd,d:u:wolf-W1hOrJ /home/wolf-W1hOrJ/knowledge/base/domains /home/wolf-W1hOrJ/librarian/inbox /home/wolf-W1hOrJ/librarian/receipts
# optional, destroys hub state: rm -rf /var/lib/hubd /opt/wolfpack-hubd /etc/wolfpack/hubd.env; userdel hubd
```
  (Removing `d:u:wolf-W1hOrJ` default entries is harmless; Dewey owns those directories.) Before deleting `/var/lib/hubd`, `hubd export --data-dir /var/lib/hubd --out hub.tar` with the service stopped.
