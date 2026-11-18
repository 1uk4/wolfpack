# Pack keys on sfo-01 (work-wolfpack-6EmU8pu)

Turns on the Pack's Keys page for sfo-01: keys sent from the Pack are stored in one key file that workerd-wolves writes and the console and hubd read. Run as root on sfo-01 after the release that contains Pack keys is installed. Every change is a systemd drop-in (`systemctl edit`), never an edit of a shipped unit. The old `.env` files stay in place the whole time, so rollback is removing the drop-ins.

**Rules for whoever runs this**
- Never print a key file or `.env`: no `cat`, `less`, `grep` of values, `journalctl` pasted into chat. Use `stat`, `wc -c`, `grep -c` and `ls -l`.
- Never delete or edit the old `.env` files (`/home/wolf-<name>/.env`, `/etc/wolfpack/*.env`).
- Anything marked **check on the box** could not be verified from the repo.

## What the code does (so you know what to expect)
- workerd stores keys only when it is given a key file explicitly (`WORKERD_KEY_FILE` or `--key-file`). There is no default location. Without it the machine shows "—" (can't take keys) in the Pack grid.
- The Pack's key wins over the machine's environment; the old places stay as fallback.
- **Subscription wolves never receive the Pack's Anthropic key.** Only wolves whose transport is `api` get `ANTHROPIC_API_KEY` from the key file, and a save restarts only those wolves. A wolf's transport is its own `"transport"` in the `models.json` beside its `wolf.yaml`; `WOLF_TRANSPORT` is only a fallback for a wolf with none (the wolf's own value always wins). If the transport cannot be determined, the wolf is treated as subscription (a metered key is never sent on a guess). workerd reports each wolf's transport in its inventory, and the Keys grid shows a muted "Claude subscription" in the Chat row for a machine whose wolves are all subscription. The Deepgram key is not affected (the console reads it itself).
- **On sfo-01 the Pack Anthropic key feeds only the hub's curator and memory** (hubd), not the wolves. A later feature (work-wolfpack-dcyQcRG) makes the bridge easy to set up.
- workerd merges the key file over the environment of every API-key wolfd it spawns. On sfo-01 workerd-wolves does not spawn wolfd itself: its "wolfd command" is `wolfd-unit.sh`, which asks systemd for `wolfd@<name>`. That env is not forwarded to the unit. So on sfo-01 a key saved in the Pack **does not reach the wolves**, and it must not: `wolfd@.service` has an `ExecStartPre` that refuses to start when `ANTHROPIC_API_KEY` is set ("a wolfd wolf never runs on a metered key", exit 78). **Do not add the key file as an `EnvironmentFile=` of `wolfd@`.** (The owner's plan listed that drop-in; it would stop every wolf. Skipped on purpose. Changing that guard is an `infra/` change and needs its own decision.)
- The console reads the key file first for the Deepgram dictation token and for the Anthropic key it uses itself (path from `WOLFPACK_KEY_FILE` only; with it unset the console has no Pack key file). It does not copy Pack keys into its own environment, so none reaches a child process. It ignores a world-writable key file (logged, never the value). It neither reads nor writes `auth.json` any more (see step 0).
- hubd and the curator/sweep read keys only from their process environment (the crawl service takes `ANTHROPIC_API_KEY` from env). An `EnvironmentFile=` drop-in on `hubd.service` covers them. No code reads the file there. **So after you change the Anthropic key, restart `hubd`** (`systemctl restart hubd.service`): its curator and memory read the environment only when the unit starts, and the Keys page shows "Saved. No wolf on this machine uses it; the hub's memory picks it up after the hub restarts."
- A pre-existing `ANTHROPIC_API_KEY` in workerd's own environment is still inherited by every wolf it spawns, so do not set one there.

## Names (verified against infra/ and deploy/)
| thing | name | source |
|---|---|---|
| workerd for VPS wolves | unit `workerd-wolves.service`, user/group `workerd-wolves`, state `/var/lib/workerd-wolves` (StateDirectoryMode 0700), env `/etc/wolfpack/workerd-wolves.env` | `infra/wolves/workerd-wolves.service` |
| link-only workerd | unit `workerd.service`, user `workerd` | `deploy/workerd/workerd.service` (not touched here: it supervises nothing, no wolves) |
| wolves | unit `wolfd@<name>.service`, user/group `wolf-<name>`, `/home/wolf-<name>/.env` mode 600 | `infra/wolves/wolfd@.service`, `provision-wolf.sh` |
| console | unit `console.service`, user/group `console`, env `/etc/wolfpack/console.env` | `deploy/console/console.service` |
| hubd | unit `hubd.service`, user/group `hubd`, env `/etc/wolfpack/hubd.env` | `deploy/hubd/hubd.service` |

List what is really on the box (names may differ):
```
systemctl list-units 'wolfd@*' workerd-wolves.service workerd.service console.service hubd.service --no-pager
getent passwd | grep -E '^(wolf-|workerd|console|hubd)' | cut -d: -f1
```

## Where the key file lives, and why not `/var/lib/workerd-wolves/keys.env`
`/var/lib/workerd-wolves` is the unit's `StateDirectory` with mode 0700, and systemd re-applies that mode on every start, so the console and hubd could never reach a file inside it. This runbook uses its own directory: **`/var/lib/wolfpack-keys/keys.env`**, directory `workerd-wolves:workerd-keys` mode `2750` (setgid so new files keep the group), file mode `0640`. (If the owner prefers the other path, it needs a different mechanism; **check on the box**.)

## 0. Before the new console starts: does the console have keys in `auth.json`?
The console no longer reads `auth.json`. Any key that lives only there (likely the Deepgram key the phone's dictation uses) stops working the moment the new console starts, unless it is moved into the Pack key file first. Do this before deploy; the file itself is never edited or deleted.
```
# where the console's auth.json is (a path, not a secret); empty = the console's default location, check on the box
grep -E '^WOLFPACK_AUTH_FILE=' /etc/wolfpack/console.env
# every key name it holds: names only, never values. The file is mode 0600, so run this as the console's user or root.
# auth.json is a flat JSON {VAR: value} map
f=<the path from above>
sudo -u <console user> node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))).join("\n"))' "$f"
# (or, as that user or root: jq -r 'keys[]' "$f")
```
For `ANTHROPIC_API_KEY` or `DEEPGRAM_API_KEY`, move the key before the new console starts, by either:
- re-entering it in Pack → Keys once the page works (dictation on the phone is off until then), or
- migrating it with workerd's one-time copy: add `WORKERD_MIGRATE_KEYS=1` and `WORKERD_MIGRATE_AUTH_JSON=<path>` as in step 4, restart `workerd-wolves`, then remove those lines. The file must be readable by `workerd-wolves`; if it is not, use the first way.

For any other name (OpenRouter, OpenAI and so on) the Pack cannot hold it. Set it in the console's service environment (`/etc/wolfpack/console.env`) before the new console starts: `keyValue` still falls back to the environment.

If the list has none of these names (or the file is absent), nothing to do.

## 1. Preconditions
```
# the release with Pack keys is installed (workerd, hubd and console all at the new version)
curl -s http://127.0.0.1:7143/healthz | head -c 300; echo          # workerd-wolves version (port 7143 per infra/wolves/README.md; check on the box)
ls -l /opt/wolfpack-workerd-wolves/current /opt/wolfpack-hubd/current /opt/wolfpack-console/current
# backups of units, drop-ins and env files (copies stay root-only; do not open them)
d=/root/pack-keys-backup-$(date +%Y%m%d-%H%M); mkdir -m 700 $d
cp -a /etc/systemd/system $d/systemd-system
cp -a /etc/wolfpack $d/etc-wolfpack
for h in /home/wolf-*; do mkdir -p $d/$(basename $h); cp -a $h/.env $d/$(basename $h)/.env; done
ls -l $d
```

## 2. The group and the directory
```
getent group workerd-keys >/dev/null || groupadd --system workerd-keys
usermod -aG workerd-keys workerd-wolves
usermod -aG workerd-keys console
usermod -aG workerd-keys hubd
# wolf users: NOT added (the wolfd@ units do not read the file, see above). Nothing else gets the group.
install -d -o workerd-wolves -g workerd-keys -m 2750 /var/lib/wolfpack-keys
install -o workerd-wolves -g workerd-keys -m 0640 /dev/null /var/lib/wolfpack-keys/keys.env
stat -c '%U:%G %a %n' /var/lib/wolfpack-keys /var/lib/wolfpack-keys/keys.env
```
Expected: `workerd-wolves:workerd-keys 2750 /var/lib/wolfpack-keys` and `workerd-wolves:workerd-keys 640 .../keys.env`. The key directory must exist before `workerd-wolves` starts (it is created here, which is why this step comes before the drop-ins in step 3). Group changes only reach a unit through `SupplementaryGroups=` below (a running service does not pick up `usermod`).

## 3. Drop-ins (each: `systemctl edit <unit>` opens an editor; paste the block, save)
**workerd-wolves** (key file, mode 640, group, write access under `ProtectSystem=strict`):
```
systemctl edit workerd-wolves.service
```
```
[Service]
Environment=WORKERD_KEY_FILE=/var/lib/wolfpack-keys/keys.env
Environment=WORKERD_KEY_FILE_MODE=640
SupplementaryGroups=workerd-keys
ReadWritePaths=/var/lib/wolfpack-keys
```
**console** (reads the file; `WOLFPACK_KEY_FILE` is the console's explicit location):
```
systemctl edit console.service
```
```
[Service]
Environment=WOLFPACK_KEY_FILE=/var/lib/wolfpack-keys/keys.env
SupplementaryGroups=workerd-keys
```
(`console.service` already sets `SupplementaryGroups=systemd-journal`; a drop-in line **adds** to it. Verify below.)

**hubd** (curator/sweep read keys from env only):
```
systemctl edit hubd.service
```
```
[Service]
EnvironmentFile=-/var/lib/wolfpack-keys/keys.env
SupplementaryGroups=workerd-keys
```
systemd reads `EnvironmentFile=` as root, so the group is not strictly needed for it; it is harmless. The file's `KEY=value` lines are validated by workerd to contain no quotes, backslash, `$`, `#` or spaces, so systemd reads them verbatim.

**wolfd@: no drop-in** (see "What the code does").

Then:
```
systemctl daemon-reload
systemctl cat workerd-wolves.service console.service hubd.service | grep -E 'WORKERD_KEY|WOLFPACK_KEY|keys.env|SupplementaryGroups|ReadWritePaths'
```

## 4. One-time migration (optional; usually skip on sfo-01)
Migration copies keys from files the workerd-wolves user can **read**. It cannot read `/home/wolf-*/.env` (mode 600, other user) or root-only files, so on sfo-01 there is normally nothing to copy; enter keys through the Pack grid instead. If you do have a readable source file:
```
systemctl edit workerd-wolves.service      # add temporarily:
#   [Service]
#   Environment=WORKERD_MIGRATE_KEYS=1
#   Environment=WORKERD_MIGRATE_ENV_FILES=/path/readable/by/workerd-wolves.env
systemctl restart workerd-wolves.service
journalctl -u workerd-wolves -n 30 --no-pager | grep 'key migration'   # names slots only, never values
```
It runs once (marker `/var/lib/workerd-wolves/keys-migrated.json`), only fills slots the file lacks, never changes the sources. Then **remove the two migration lines** from the drop-in (`systemctl edit workerd-wolves.service`) and `daemon-reload`.

## 5. Restart order
```
systemctl restart workerd-wolves.service     # wolves keep running (KillMode=control-group, wolfd@ units are left alone; workerd re-adopts them)
systemctl restart hubd.service
systemctl restart console.service
systemctl is-active workerd-wolves hubd console 'wolfd@*'
```
If the console is the one you are using, expect a short drop.

## 6. Verify
```
stat -c '%U:%G %a %s bytes' /var/lib/wolfpack-keys/keys.env        # workerd-wolves:workerd-keys 640
ls -ld /var/lib/wolfpack-keys                                       # drwxr-s--- workerd-wolves workerd-keys
systemctl show console -p SupplementaryGroups -p Environment | tr ' ' '\n' | grep -E 'keys|journal'   # no key values here, only the path
id workerd-wolves console hubd | grep -c workerd-keys              # 3
```
1. Pack panel > Keys: sfo-01 appears with its slots; send an Anthropic or Deepgram key sealed to sfo-01-wolves. Expect "Saved." and the cell showing `••••xxxx · Pack`.
2. `wc -c /var/lib/wolfpack-keys/keys.env` grew; `grep -c '^DEEPGRAM_API_KEY=' /var/lib/wolfpack-keys/keys.env` is 1 (count only, never print).
3. Dictation: use the mic in the console; the token route now reads the Pack's Deepgram key.
4. A wolf answers: send a message to a wolf in the console and get a reply (wolves are unchanged by this runbook).
5. Journals show no key. This must print `0`:
```
journalctl -u workerd-wolves -u console -u hubd --since '30 min ago' --no-pager | grep -cE 'sk-ant-|DEEPGRAM_API_KEY=|ANTHROPIC_API_KEY='
```
(If the count is not 0, do not paste lines anywhere; tell the owner and rotate the key.)

## 7. Rollback
The old `.env` files were never touched, so:
```
systemctl revert workerd-wolves.service console.service hubd.service    # removes the drop-ins
systemctl daemon-reload
systemctl restart workerd-wolves.service hubd.service console.service
systemctl cat workerd-wolves.service | grep -c keys.env                 # 0
```
The key file and group can stay (unused) or be removed later: `rm /var/lib/wolfpack-keys/keys.env` only after the owner confirms. Never delete the backup directory from step 1 until the owner says so.

## What NOT to do
- Never `cat`/`less`/`tail` `keys.env`, any `.env`, `auth.json` or `credentials.json`; use `stat`, `wc -c`, `grep -c`.
- Never delete or "clean up" the old `.env` files.
- Never put the key file in `wolfd@`'s `EnvironmentFile=` while its `ExecStartPre` refuses `ANTHROPIC_API_KEY`.
- Never edit files under `/etc/systemd/system/*.service` directly or the shipped units in the repo; use drop-ins.
- Never run `--migrate-keys` / `WORKERD_MIGRATE_KEYS=1` permanently.

## Could not verify (check on the box)
- Port 7143 for the healthz probe and that `curl` to it is allowed (from `infra/wolves/README.md`).
- That `workerd-wolves` runs the new workerd bundle with `WORKERD_KEY_FILE` honoured (needs the release build).
- That `SupplementaryGroups=` in a drop-in adds to (not replaces) `console.service`'s `systemd-journal`; confirm with `systemctl show console -p SupplementaryGroups`.
- That `ReadWritePaths=` in the drop-in is enough under `ProtectSystem=strict` for the atomic temp-file + rename in `/var/lib/wolfpack-keys` (look for EACCES/EROFS in `journalctl -u workerd-wolves`).
- The real unit/user names on the box (listing commands above), and that no extra wolves or consoles exist beyond `infra/`.
- Whether sfo-01's console holds keys in `auth.json`: see step 0.
