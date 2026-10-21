# Wolfpack ops reference (for investigators)

Pass this file's path in an investigator brief. Commands marked **[RO]** are read-only; anything unmarked changes state — do not run it. Never print `.env`, `apiKey` or token values.

## Hosts and ssh
- Registered hosts live in `~/.wolfpack/config.yaml` (`hosts:`; **read it only for names/addresses, it contains API keys**). Current host: `sfo-01` (address `100.120.154.69`, Tailscale; agent port 3141).
- ssh: `ssh -i ~/.ssh/wolfpack -o BatchMode=yes -o ConnectTimeout=5 root@100.120.154.69 '<cmd>'` — user `root`, port 22. Keep remote commands bounded and non-interactive.

## Wolves (id ↔ name)
| name | id | runtime | host |
|---|---|---|---|
| hal | ETAy7b | pi-durable | sfo-01 |
| dewey (librarian) | W1hOrJ | pi-durable | sfo-01 |
| 1uk4 | ddkyhT | pi (local) | this Mac |

Service/user/home names use the **id**, not the name: `wolf-<id>`.

## Local first (check before ssh) **[RO]**
- Syncthing mirrors of VPS dens: `~/wolves/<host>/<wolf>/den/` e.g. `~/wolves/sfo-01/hal/den/`. Contains `session.sqlite` (+ `-wal`/`-shm`; open read-only, e.g. `sqlite3 -readonly`), `status.json`, `memory/`, `tasks/`, `kb/`, `usage/<YYYY-MM>.jsonl` (engine usage).
- Local wolf 1uk4: `~/wolves/local/1uk4/{wolf.yaml,models.json,den/,agent/,logs/}`; den has `usage/`, `status.json`, `work-system.log`.
- Mirror freshness: compare file mtimes (`ls -l`) with now; a stale mirror means sync is lagging, not that the wolf is idle.
- CLI (local, talks to the agent API): `wolfpack list`, `wolfpack status`, `wolfpack logs <wolf> [--lines N] [--host sfo-01]` **[RO]** (do not use `--follow` unless bounded). `wolfpack restart|sync|launch|redeploy` change state — don't.

## VPS layout (per wolf)
`/home/wolf-<id>/`:
- `wolf.yaml` — wolf config (id, name, runtime, profile, domains, extensions) **[RO]**
- `models.json` — resolved model table **[RO]**
- `.env` — SECRETS (mode 600). Never print. To check a key exists: `grep -c '^NAME=' /home/wolf-<id>/.env`.
- `den/` — private working memory (session.sqlite, memory, tasks…) **[RO]**
- `agent/harness.cjs`, `agent/launch.sh` — the pi-durable harness and its launcher **[RO]**

## systemd **[RO]**
- Unit `wolf-<id>.service` (runs `agent/launch.sh` as user `wolf-<id>`, env from `.env`).
- `systemctl status wolf-<id> --no-pager -n 20`; `systemctl is-active wolf-<id>`
- `journalctl -u wolf-<id> --since "1 hour ago" --no-pager -n 200` (also `-p err`, `--until`)
- Agent API service: `wolfpack-agent` (`/opt/wolfpack-agent/wolfpack-agent.cjs`); `journalctl -u wolfpack-agent --since …`
- Other services: `tailscaled`, `ollama` (KB embeddings). `systemctl list-units 'wolf*' --no-pager`.
- `restart|stop|start|enable|disable|daemon-reload` change state — don't.

## Knowledge base on the VPS
- `/var/wolfpack/kb/base` — curated KB (`domains/<domain>/entries`, `INDEX.md`, `_registry.md`); `/var/wolfpack/kb/ops` — Syncthing lanes: `inbox/<wolf>/` (contributions waiting for the next sweep), `parked/<wolf>/` (contributions that failed and need attention), `receipts/`, `rejected/`; `/var/wolfpack/kb/work` — work-item ledger. **[RO]** `ls`, `head`.
- KB admin CLI `/opt/wolfpack-kb/cli.cjs`, run as the librarian's user (dewey = `wolf-W1hOrJ`) with its env:
  `sudo -u wolf-W1hOrJ bash -c 'node /opt/wolfpack-kb/cli.cjs status'` **[RO]** (health dashboard, lists parked items; needs the wolf's env vars exported from its `.env` — the local `wolfpack kb status` does this for you and is preferred).
  `... cli.cjs unpark --list` **[RO]**; `unpark <wolf>/<file>|--all` moves parked items back to the inbox (state change — don't). `sweep`, `reorg`, `rebuild`, `reindex`, `retire` change state — don't.

## Agent API (port 3141, `X-API-Key` header required except dashboard)
- `GET /dashboard` (no auth), `GET /dashboard/api/kb-graph`
- `GET /health` (host + service check); `POST /health/fix-kb-permissions` (changes state)
- `GET /wolves`, `GET /wolves/:nameOrId`; `POST /wolves`, `PUT /wolves/:id/bundle`, `PATCH /wolves/:id/config`, `POST /wolves/:id/restart|stop`, `DELETE /wolves/:id` — only the GETs are **[RO]**
- `GET /logs/:nameOrId?lines=N[&follow=1]` — journalctl of `wolf-<id>` **[RO]**
- `GET /work`, `GET /work/:id` **[RO]**; `POST/PATCH/DELETE /work…` (work-item ledger) change state
- `POST /transcribe` (whisper)
- Don't send the key anywhere but the matching host; mask it in output.
