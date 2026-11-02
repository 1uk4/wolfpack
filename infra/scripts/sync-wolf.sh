#!/usr/bin/env bash
# sync-wolf.sh — wire a wolf's den backup folder into Syncthing.
#
# The pack's topology is hub-and-spoke: every folder is shared with the Mac hub
# and never wolf-to-wolf. The Mac is where you read the vaults, so a folder that
# is not shared with the hub is invisible no matter how healthy it looks here.
#
# Syncthing carries DEN BACKUPS ONLY, until feature H3GuSmC builds a backup
# system and removes it. The KB and the ops lanes are not synced here: KB
# distribution is hub-only (hubd + workerd link + kb-sync mirror).
#
#   den-<host>-<wolf-id> <-> <mac wolfpack checkout>/dens/<wolf>   bidirectional
#
# This script NEVER creates folders. `wolfpack mesh` is the only creator: it
# knows the per-wolf Syncthing instances (wolf-<id>-syncthing on per-wolf GUI
# ports), while this script only talks to the host-level :8384. Here a den folder
# is matched by id or by realpath of the den path and REPORTED. The old additive
# "share with mac-hub" PUT is gone too (report-only): a folder not shared with
# the hub is flagged with a `wolfpack mesh` hint instead of being edited.
#
# <host> is $WOLF_HOST (set by `wolfpack sync`, else `hostname -s`). <wolf-id> is
# the wolf ID (the id in wolf.yaml, as in packages/cli mesh.ts denFolderId), NOT
# the wolf name; it comes from $WOLF_ID, else `id:` in <den>/../wolf.yaml, and is
# used only for the id match.
#
# The old kb-*, ops-inbox-*, ops-receipts-* and wolfpack-shared folders are NOT
# pruned by this script; they were removed on the hosts by hand.
#
# Run via `wolfpack sync`. Idempotent — it repairs drift instead of duplicating,
# and never edits an existing folder's versioning or type.

set -uo pipefail

WOLF_USER="${WOLF_USER:-wolf}"
WOLF_HOST="${WOLF_HOST:-$(hostname -s)}"
export WOLF_USER WOLF_HOST
export CONFIG_XML="/home/${WOLF_USER}/.local/state/syncthing/config.xml"
export API="http://127.0.0.1:8384/rest"

if [ -t 1 ]; then
  RED=$'\e[31m'; R=$'\e[0m'
else
  RED=""; R=""
fi

die() { printf '%ssync:%s %s\n' "$RED" "$R" "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "must run as root (use: wolfpack sync)"
[ -r "$CONFIG_XML" ] || die "no Syncthing config at $CONFIG_XML — is syncthing@${WOLF_USER} running?"

MODE="status"; TARGET=""
case "${1:-}" in
  "")        MODE="status" ;;
  -*)        die "usage: wolfpack sync [wolf]" ;;
  *)         MODE="den"; TARGET="$1" ;;
esac

exec python3 - "$MODE" "$TARGET" <<'PY'
import json, os, re, sys, subprocess, urllib.request, urllib.error

MODE, TARGET = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else ""
USER, CONFIG_XML, API = os.environ["WOLF_USER"], os.environ["CONFIG_XML"], os.environ["API"]
HOST = os.environ["WOLF_HOST"]

tty = sys.stdout.isatty()
B, DIM, R = ("\033[1m", "\033[2m", "\033[0m") if tty else ("", "", "")
CYA, YEL, RED, GRN = ("\033[36m", "\033[33m", "\033[31m", "\033[32m") if tty else ("",) * 4

def die(msg):
    print(f"{RED}sync:{R} {msg}", file=sys.stderr); sys.exit(1)

def step(msg): print(f"{CYA}==>{R} {msg}")
def note(msg): print(f"    {msg}")

with open(CONFIG_XML) as f:
    m = re.search(r"<apikey>([^<]+)</apikey>", f.read())
if not m:
    die("could not read the API key out of config.xml")
KEY = m.group(1)

def api(method, path, body=None):
    req = urllib.request.Request(
        API + path, method=method,
        headers={"X-API-Key": KEY, "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        die(f"REST {method} {path} -> {e.code}: {e.read().decode()[:200]}")
    except OSError as e:
        die(f"cannot reach the Syncthing API at {API} ({e})")

devices = api("GET", "/config/devices") or []
me = api("GET", "/system/status")["myID"]
hub = next((d for d in devices if d.get("name") == "mac-hub"), None)
if not hub:
    die("no device named 'mac-hub' — pair the Mac first, then re-run")
HUB = hub["deviceID"]

def den_path(wolf):
    # Wolves from `wolfpack add` live under wolves/<name>/den; the first wolf on
    # a host predates that layout and sits in workspace/den.
    p = f"/home/{USER}/wolves/{wolf}/den"
    return p if os.path.isdir(p) else f"/home/{USER}/workspace/den"

def wolf_id(wolf, den):
    """The wolf ID for new folder ids: $WOLF_ID, else `id:` in <den>/../wolf.yaml
    (only when its `name:` matches). Never derived from the name."""
    if os.environ.get("WOLF_ID"):
        return os.environ["WOLF_ID"]
    p = os.path.join(os.path.dirname(den.rstrip("/")), "wolf.yaml")
    try:
        txt = open(p).read()
    except OSError:
        return ""
    i = re.search(r"^id:\s*[\"']?([A-Za-z0-9_-]+)", txt, re.M)
    n = re.search(r"^name:\s*[\"']?([^\"'\n]+)", txt, re.M)
    if i and (not n or n.group(1).strip() == wolf):
        return i.group(1)
    return ""

def wolves():
    out = subprocess.run(["systemctl", "show", "*.service", "--property=Id,Description",
                          "--no-pager"], capture_output=True, text=True).stdout
    found = []
    for block in out.split("\n\n"):
        d = re.search(r"^Description=Wolfpack - (.+)$", block, re.M)
        if d:
            found.append(d.group(1).strip())
    return sorted(set(found))

def folder_by_path(folders, path):
    return next((f for f in folders if os.path.realpath(f["path"]) == os.path.realpath(path)), None)

def shared_with_hub(folder):
    ids = {d["deviceID"] for d in folder.get("devices", [])}
    return me in ids and HUB in ids

def upsert(folder_id, label, path, ftype, rescan):
    """Report-only (name kept for the caller). Returns the existing folder id, or
    "" when there is none; never writes."""
    folders = api("GET", "/config/folders") or []

    # Reuse whatever folder already owns this path, whatever it is called. Folder
    # ids survive a wolf rename, so one may not match its wolf.
    existing = next((f for f in folders if folder_id and f["id"] == folder_id), None) or folder_by_path(folders, path)

    if existing:
        if existing["id"] != folder_id:
            note(f"{YEL}!{R} path already synced as '{existing['id']}' — keeping that id")
        if shared_with_hub(existing):
            step(f"'{existing['id']}' already wired")
        else:
            note(f"{YEL}!{R} '{existing['id']}' is not shared with mac-hub; not editing; run: wolfpack mesh")
        return existing["id"]

    note(f"{YEL}!{R} no folder at {path}; not creating; run: wolfpack mesh")
    return ""

def mac_steps(folder_id, mac_path, mac_type):
    ts = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True).stdout.strip().split("\n")[0]
    print()
    print(f"{B}On the Mac{R} — Syncthing at http://localhost:8384")
    print(f"  This host's device ID:  {me}")
    if ts:
        print(f"  If it will not connect, set the device address to tcp://{ts}:22000")
    print(f"  Accept folder {B}{folder_id}{R}")
    print(f"    Path:  ~/Code/wolfpack/{mac_path}")
    print(f"    Type:  {mac_type}")
    print(f"  {DIM}Then open ~/Code/wolfpack/ as the Obsidian vault root.{R}")

# ---------------------------------------------------------------- status ----
if MODE == "status":
    conns = api("GET", "/system/connections")["connections"]
    up = conns.get(HUB, {}).get("connected", False)
    print(f"{B}Hub{R}  mac-hub  {GRN + 'connected' + R if up else RED + 'DISCONNECTED' + R}")
    if not up:
        print(f"     {DIM}nothing reaches your Mac until this is up{R}")
    print()
    allf = [f for f in (api("GET", "/config/folders") or []) if f["id"]]
    W = max([18] + [len(f["id"]) for f in allf]) + 2
    print(f"{B}{'FOLDER':<{W}} {'TYPE':<12} {'FILES':>6}  {'HUB':>6}  PATH{R}")
    for f in sorted(api("GET", "/config/folders") or [], key=lambda x: x["id"]):
        if not f["id"]:
            continue
        st = api("GET", f"/db/status?folder={f['id']}") or {}
        shared = any(d["deviceID"] == HUB for d in f.get("devices", []))
        # Pad before colouring — ANSI escapes count toward str formatting width.
        def cell(text, colour=""):
            return colour + text.rjust(6) + (R if colour else "")
        if not shared:
            pct = cell("none", RED)
        else:
            comp = api("GET", f"/db/completion?folder={f['id']}&device={HUB}") or {}
            # completion reads 100% for a folder the Mac has merely been offered
            # and never accepted, because it needs nothing it does not know about.
            # remoteState is the field that tells the truth.
            if comp.get("remoteState") == "valid":
                pct = cell(f"{comp.get('completion', 0):.0f}%")
            else:
                pct = cell("accept", YEL)
        print(f"{f['id']:<{W}} {f['type']:<12} {st.get('localFiles', 0):>6}  {pct}  {f['path']}")
    print()
    print(f"{DIM}accept = offered to the Mac but not accepted there yet{R}")
    print(f"{DIM}wolfpack sync <wolf>        wire a den backup folder{R}")
    sys.exit(0)

# ------------------------------------------------------------------- den ----
if MODE == "den":
    if TARGET not in wolves():
        die(f"no wolf named '{TARGET}'. Known: {' '.join(wolves())}")
    den = den_path(TARGET)
    wid = wolf_id(TARGET, den)
    fid = upsert(f"den-{HOST}-{wid}" if wid else "", f"{TARGET}-den", den, "sendreceive", 60)
    if fid:
        mac_steps(fid, f"dens/{TARGET}", "Send & Receive")
    sys.exit(0)
PY
