#!/usr/bin/env bash
# Local check for infra/roles/syncthing: renders the embedded python, runs it
# against a stub Syncthing REST API, and asserts the role NEVER writes a folder
# (`wolfpack mesh` is the only creator):
#   1. a pre-existing folder at the den path (any id) is matched, nothing written;
#   2. no folder and no wolf_id: nothing written, "run: wolfpack mesh";
#   3. no folder even WITH wolf_id: still nothing written, same hint;
#   4. a folder whose path is a SYMLINK to the den, with a different id, matches
#      by realpath and nothing is written.
# Run (no npm script exists for infra; package.json is outside this change):
#   bash infra/tests/syncthing-role-folder-match.sh      # prints "ok: 4 cases"
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
        def _write(self):
            n = int(self.headers.get("Content-Length", 0)); posted.append((self.command, self.path, self.rfile.read(n)))
            self._send({})
        do_POST = do_PUT = do_PATCH = do_DELETE = _write
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

link = os.path.join(tmp, "den-link"); os.symlink(den, link)

live = [{"id": "den-sfo-01-W1hOrJ", "path": den, "type": "sendonly", "devices": []}]
posted, out = run(live, "ETAy7b")
assert posted == [], f"wrote: {posted}"
assert "den-sfo-01-W1hOrJ" in out and "already present" in out, out
posted, out = run([], "")
assert posted == [] and "run: wolfpack mesh" in out, (posted, out)
posted, out = run([], "ETAy7b")
assert posted == [] and "not creating; run: wolfpack mesh" in out, (posted, out)
posted, out = run([{"id": "den-other-xxxx", "path": link, "type": "sendreceive", "devices": []}], "ETAy7b")
assert posted == [] and "den-other-xxxx" in out and "already present" in out, (posted, out)
print("ok: 4 cases")
PY
