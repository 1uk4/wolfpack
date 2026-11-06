# Wolfpack console on sfo-01 (runbook)

The console (Next.js, `output: standalone`) runs as the `console` user on `127.0.0.1:3200`. `tailscale serve` publishes it on the tailnet over HTTPS at the **origin root**; hubd sits under **`/hub`** on the same origin. Nothing here is applied until the owner approves each step. Written without host access: items marked **UNVERIFIED** are acceptance checks to run on the host, not facts.

Files: `deploy/console/{setup.sh,console.service,console.env.example}`, `deploy/tailscale/serve.sh`, release component `console` (`console/vX.Y.Z` tag, asset `console-vX.Y.Z-linux-x64.tar.gz`), deploy with `infra/release/deploy-release.sh console X.Y.Z`.

## Configuration (`/etc/wolfpack/console.env`, root:root 600, written only if missing)

| Name | Meaning |
|---|---|
| `CONSOLE_HOST` / `CONSOLE_PORT` | bind; the unit refuses anything but 127.0.0.1; port 1024-65535, not 3141/3150 |
| `WOLFPACK_CONSOLE_PUBLIC_ORIGIN` | `https://<host>.ts.net`, required; decides the `__Host-` cookie names (the unit refuses a non-https value) |
| `WOLFPACK_HUB_URL` | where the **server** reaches hubd (today `http://100.120.154.69:3150`) |
| `HUBD_PUBLIC_URL` | `https://<host>.ts.net/hub`, for the `/pair` link and the Devices panel's pairing link. Read **at runtime** (`/api/hub-url`, `src/server/hub-public-url.ts`); `NEXT_PUBLIC_WOLFPACK_HUB_URL` is no longer needed at build time (still honoured as a last fallback) |
| `WOLFPACK_DATA_DIR` | `/var/lib/console/data`: the console's own state (settings, KB graph cache). `setup.sh` creates it `console:console 0700` if missing (the `/var/lib/console` home is created the same way) |
| `WOLFPACK_HUB_TOKEN` | optional, `/api/health` hub probe only. The console forwards only the browser's device token |

hubd's own `/etc/wolfpack/hubd.env` gets the same two public values: `HUBD_PUBLIC_URL=https://<host>.ts.net/hub` (pairing QR) and `HUBD_CONSOLE_URL=https://<host>.ts.net` (where the pairing page redirects with `#token=`), then `systemctl restart hubd`.

## Host rollout plan (each step has its own rollback; stop at any step)

**(a) Deploy the console** (not yet reachable from anywhere but the host)
1. Tag `console/vX.Y.Z` on the approved commit (owner pushes; CI builds the linux-x64 tarball).
2. On sfo-01 as root: unpack the release once and `bash console/setup.sh --dry-run setup`, read it, then `bash console/setup.sh setup`. Edit `/etc/wolfpack/console.env` (replace the `CHANGE-ME` host names). `bash console/setup.sh install --bundle console`, then `systemctl start console`.
   Later upgrades: `infra/release/deploy-release.sh console X.Y.Z` (verifies sha256, installs, health = unit active + HTTP 200 on `/api/health` or `/` from localhost, auto-rollback).
3. Check: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3200/` is 200; `ss -ltn | grep 3200` shows 127.0.0.1 only.
- Rollback: `systemctl disable --now console`; or `bash /opt/wolfpack-console/setup.sh rollback`; full removal `setup.sh uninstall` (add `--purge` for user, state and env). No other system is changed by this step.

**(b) `tailscale serve`** (tailnet only; never `funnel`)
1. `tailscale version`, `tailscale serve --help` (confirm `--bg --https --set-path` exist; HTTPS needs MagicDNS + HTTPS certificates enabled in the tailnet admin console, owner action).
2. `bash deploy/tailscale/serve.sh --dry-run on`, then `... on`, then `... status`. The routes: `/hub` → `http://100.120.154.69:3150` and `/` → `http://127.0.0.1:3200`.
3. Acceptance from a tailnet device (all **UNVERIFIED** until run):
   - `curl -sI https://<host>.ts.net/` → 200 from the console.
   - `curl -s -o /dev/null -w '%{http_code}' https://<host>.ts.net/hub/v1/wolves` → 401 (hubd answered; the `/hub` prefix was stripped, since hubd has no `/hub/...` routes).
   - **`/hub/pair` with no trailing slash** returns hubd's pairing page (200). Expected: serve matches `/hub` as a path prefix and forwards `/pair`. hubd's page computes its POST URL from `location.pathname` (`/hub/pair` → `/hub/v1/pair`), so it works with the prefix stripped, with or without a trailing slash (pinned by `hubd.pairpage.test.ts`). If bare `/hub/pair` is not forwarded as `/pair`, fall back to a trailing-slash link and say so here.
   - **SSE `/hub/v1/events`** (`curl -N -H 'Authorization: Bearer <token>' https://<host>.ts.net/hub/v1/events`): the same stripping applies; also confirm events arrive as they happen, not in a buffered burst. tailscale serve is a Go reverse proxy that streams `text/event-stream`; **UNVERIFIED**. The worker link (`/hub/v1/link`, WebSocket) is likewise untested through serve; it matters only for step (d).
4. Add the public values to `hubd.env` (see above) and restart hubd.
- Rollback: `bash deploy/tailscale/serve.sh off` (removes only these two routes; never `serve reset`); revert the two `hubd.env` lines and restart hubd. The tailnet-IP hubd keeps working throughout.

**(c) Pair the owner's phone over HTTPS**
1. On sfo-01: `hubd pair --kind browser` (prints a QR/link built from `HUBD_PUBLIC_URL`), or Settings → Devices → "Add device" in an already-paired console (its link comes from `HUBD_PUBLIC_URL` at runtime).
2. Phone on the tailnet opens the link, pairs, lands on `https://<host>.ts.net/pair#token=…` → stored → home. Check Settings → Devices shows the phone.
- Rollback: revoke the device (Settings → Devices, or `hubd devices revoke`). No infrastructure change.

**(d) Mac workerd link** (only if wanted)
Nothing has to move: the Mac's workerd links to `http://100.120.154.69:3150`, which stays valid while hubd keeps its tailnet bind. Move to `https://<host>.ts.net/hub` only if you want TLS on the link or are about to do (e); it needs the WebSocket upgrade through serve (**UNVERIFIED**, test with `wscat`/workerd against a throw-away device first). Change the hub URL in the Mac workerd config (`hub.json`, restart workerd). 
- Rollback: set the URL back to `http://100.120.154.69:3150`, restart workerd.

**(e) "Close hubd's public port"**
"Public" needs care: hubd binds the **tailnet IP** `100.120.154.69:3150` (`HUBD_HOST`), not `0.0.0.0` (the unit refuses wildcards), so it is not on the public internet. It is reachable by every device the tailnet ACLs allow, over **plain HTTP** (tailnet traffic is WireGuard-encrypted, so not cleartext on the wire). After (b) it is also reachable at `https://<host>.ts.net/hub`. To check what else is exposed, on the host: `ss -ltnp` (expect 3150 on the tailnet IP, 3200 on 127.0.0.1, sshd, nothing on `0.0.0.0` that you did not choose) and `tailscale serve status` / `tailscale funnel status` (funnel must be empty). Firewall state on sfo-01 was not inspected.
- Recommendation: **do not move hubd to 127.0.0.1 in this phase.** What would break if you did (`HUBD_HOST=127.0.0.1`, restart hubd, and serve upstream `http://127.0.0.1:3150` via `serve.sh on --hub-upstream http://127.0.0.1:3150`):
  - the Mac's workerd (links to the tailnet IP) → must move to `https://<host>.ts.net/hub` first (step d, needs the WebSocket check);
  - workerd on sfo-01 (and `workerd-wolves`, wolfd links, anything with `hubUrl` = the tailnet IP in `hub.json`) → change to `http://127.0.0.1:3150` and restart;
  - the console's `WOLFPACK_HUB_URL` → `http://127.0.0.1:3150`;
  - any phone/browser or script using `http://100.120.154.69:3150` directly.
  Do it only after all links are listed and moved, one at a time (hub.json edits, restart, confirm the link is up in the console), hubd last.
- Rollback: `HUBD_HOST=100.120.154.69` in `hubd.env`, restart hubd, point the links back (`serve.sh on --hub-upstream http://100.120.154.69:3150`).

## Operate

- Logs: `journalctl -u console -n 100 --no-pager`. Restart: `systemctl restart console`.
- Health: `curl -s http://127.0.0.1:3200/api/health` (`{"ok":true}`, 200 when its hub link works; with no token configured it reports on the console only).
- Release layout: `/opt/wolfpack-console/{releases,current,previous}`, 5 releases kept.
- The console is served at the origin root only (absolute `/api/...` URLs, no `basePath`).
