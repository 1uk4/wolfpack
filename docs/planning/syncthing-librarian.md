# Syncthing Setup — Librarian

> **Note:** When running `ansible-playbook` manually, use `set -a && source .env && set +a`
> instead of just `source .env` — the `-a` flag exports all vars so Ansible's
> `lookup('env', ...)` can see them.

Two new Syncthing folders to configure after provisioning the librarian wolf.

---

## Folder 1: `kb-base` — Knowledge base

| Setting | Mac | wolf-01 |
|---|---|---|
| Folder ID | `kb-base` | `kb-base` |
| Local path | `~/Code/wolfpack/knowledge/base` | `/home/wolf/knowledge/base` |
| Folder type | **Send & Receive** | **Receive Only** |
| Share with | wolf-01 device | Mac device |

**Direction:** Mac is the source of truth. Librarian writes on wolf-01,
which syncs up to Mac. Mac distributes to other wolves via their own
`kb-base` receive-only folders.

For each additional wolf that needs to read the knowledge base, add another
receive-only folder on that wolf's host pointing at:
`/home/wolf/wolves/<wolf-name>/knowledge/base`

---

## Folder 2: `librarian-ops` — Inbox + receipts

| Setting | Mac | wolf-01 |
|---|---|---|
| Folder ID | `librarian-ops` | `librarian-ops` |
| Local path | `~/Code/wolfpack/librarian` | `/home/wolf/librarian` |
| Folder type | **Send & Receive** | **Send & Receive** |
| Share with | wolf-01 device | Mac device |

**Direction:** Bidirectional. Wolves write claims to inbox, librarian writes
receipts back. Both flow through the Mac hub.

---

## Steps

1. On the Mac, open Syncthing (http://localhost:8384)
2. Add Folder → set Folder ID and local path for both folders above
3. Share each folder with the wolf-01 device
4. On wolf-01, accept both folder share requests
5. Set `kb-base` to **Receive Only** on wolf-01

For other wolves (hal, forge, snapjack-bi) to read the knowledge base:
- Their `librarian-ops` inbox/receipts are already in this folder — they see
  their own inbox and receipts subdirectories
- For `kb-base` read access: add a symlink in their dens pointing at
  `/home/wolf/knowledge/base`, or add them as receive-only recipients of
  the `kb-base` folder

---

## .stignore recommendations

Add to `librarian-ops/.stignore` on all devices:
```
.gitkeep
_processed/
```

Add to `kb-base/.stignore` on all devices:
```
.git/
```
(Syncthing should not sync the git internal state — git is local to wolf-01)
