#!/usr/bin/env bash
# Local check for infra/roles/syncthing: renders the embedded python, runs it
# against a stub Syncthing REST API, and asserts that
#   1. a pre-existing folder at the den path (any id) is kept, nothing POSTed;
#   2. with no folder and no wolf_id, nothing is created;
#   3. with no folder and wolf_id set, den-<host>-<wolf-id> is created.
# Usage: infra/tests/syncthing-role-folder-match.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
exec python3 -I - "$HERE/../roles/syncthing/tasks/main.yml" <<'PY'
import http.server, json, os, re, subprocess, sys, tempfile, threading

src = open(sys.argv[1]).read()
block = re.search(r"python3 - <<'PY'\n(.*?)\n    PY\n", src, re.S).group(1)
block = "\n".join(l[4:] if l.startswith("    ") else l for l in block.split("\n"))

tmp = tempfile.mkdtemp()
den = os.path.join(tmp, "den"); os.makedirs(den)
cfg = os.path.join(tmp, "config.xml"); open(cfg, "w").write("<apikey>k</apikey>")
MAC = "MACMACM-AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG"

def run(folders, wolf_id):
    posted = []
    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def _send(self, obj):
            b = json.dumps(obj).encode(); self.send_response(200)
            self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
        def do_GET(self):
            self._send([{"deviceID": MAC}] if self.path.endswith("/devices") else folders)
        def do_POST(self):
            n = int(self.headers.get("Content-Length", 0)); posted.append((self.path, json.loads(self.rfile.read(n))))
            self._send({})
    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    code = block
    code = code.replace("{{ wolf_user }}", "wolf").replace("{{ mac_syncthing_device_id }}", MAC)
    code = code.replace("{{ wolf_name }}", "hal").replace("{{ syncthing_host }}", "sfo-01")
    code = code.replace("{{ wolf_id | default('') }}", wolf_id)
    code = re.sub(r"\{\{ wolf_den.*?\}\}", den, code)
    code = code.replace("/home/wolf/.local/state/syncthing/config.xml", cfg)
    code = code.replace("http://127.0.0.1:8384/rest", f"http://127.0.0.1:{srv.server_port}/rest")
    r = subprocess.run([sys.executable, "-I", "-c", code], capture_output=True, text=True)
    srv.shutdown()
    assert r.returncode == 0, r.stderr
    return posted, r.stdout

live = [{"id": "den-sfo-01-W1hOrJ", "path": den, "type": "sendonly", "devices": []}]
posted, out = run(live, "ETAy7b")
assert posted == [], f"existing folder duplicated: {posted}"
assert "den-sfo-01-W1hOrJ" in out
posted, out = run([], "")
assert posted == [] and "not creating" in out, out
posted, out = run([], "ETAy7b")
assert len(posted) == 1 and posted[0][1]["id"] == "den-sfo-01-ETAy7b" and posted[0][1]["path"] == den, posted
print("ok: 3 cases")
PY
