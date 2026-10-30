# hubd: listening modes and Caddy TLS

hubd has **no built-in TLS** and **no certificate pinning**. Transport security comes from the network (Tailscale) or from a reverse proxy (Caddy) in front of it. Auth is always the device token (`hubd pair`), in every mode.

`serve` listens in exactly one of two ways. `--socket` with `--port`/`--host` (or `HUBD_SOCKET` with them) is refused at start-up.

| Mode | Flags / env | Use |
|---|---|---|
| TCP (default) | `--host 127.0.0.1 --port 3142` | Mac-only setup (localhost), or a Tailscale IP on the VPS. Default port is 3142; never 3141. |
| Unix socket | `--socket /abs/path/hubd.sock [--socket-mode 0660]`, or `HUBD_SOCKET` / `HUBD_SOCKET_MODE` | Behind a reverse proxy on the same host. |

## Mac-only, no Tailscale

Run hubd on loopback and point workerd at it:

    hubd serve --data-dir ~/hub --port 3142       # 127.0.0.1 by default

workerd uses the hub URL `http://127.0.0.1:3142`. Nothing leaves the machine, so no TLS is needed. workerd dials TCP only; for a unix-socket hub, put a proxy in front (below).

## Unix socket

    hubd serve --data-dir /var/wolfpack/hub --socket /run/hubd/hubd.sock --socket-mode 0660

- The path must be absolute, its directory must exist, and it must fit the OS limit (103 bytes).
- The socket is created under umask 077 and then set to exactly `--socket-mode` (default `0660`). Modes with any world bit, or without owner read/write, are refused. Give the proxy access through a **group**: put the proxy user in hubd's group and keep the directory `0750`.
- A leftover socket from a dead hubd is removed at start. A socket another process still answers on, or a path that is not a socket, makes hubd refuse to start and leaves it alone.
- hubd removes the socket on clean shutdown (SIGINT/SIGTERM).
- systemd: use `RuntimeDirectory=hubd` and `RuntimeDirectoryMode=0750` for `/run/hubd`.

## Caddy in front (TLS without Tailscale)

Caddy terminates TLS (automatic certificates for a public name, or `tls internal` for a private CA) and proxies to hubd:

    hub.example.com {
        reverse_proxy unix//run/hubd/hubd.sock
    }

or, with a TCP hubd on loopback: `reverse_proxy 127.0.0.1:3142`.

- The worker link (`GET /v1/link`) and the event stream are long-lived. `reverse_proxy` handles WebSocket upgrades and streaming without extra config; do not add request or response timeouts, and keep `flush_interval -1` if you see buffered SSE.
- Workers and consoles then use `https://hub.example.com` as the hub URL. Clients validate the certificate through the normal system trust store (there is no pinning); for `tls internal`, install Caddy's root CA on each client.
- Set `HUBD_PUBLIC_URL` to the public https URL so `hubd pair --kind browser` prints a working QR link.
- Lock the proxy down: expose only the hub vhost, and do not publish the socket or the loopback port otherwise. Pairing codes are single-use and expire after 10 minutes, but the pair endpoint is reachable by anyone who can reach the vhost, so rate-limit it at the proxy if it is on the public internet.
