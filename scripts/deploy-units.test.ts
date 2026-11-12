import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// work-wolfpack-jScCkFy: `setup.sh install` is the one path every deploy takes (deploy-release.sh and the auto-updater call it),
// so a changed unit in the bundle must land on a host that already has one. Driven with SETUP_ROOT (temp tree) and a stubbed systemctl.
const repo = join(__dirname, "..");
const tmps: string[] = [];
afterEach(() => { while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true }); });

const put = (path: string, body: string, mode = 0o644) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); chmodSync(path, mode); };

function install(comp: "console" | "hubd" | "workerd") {
  const root = mkdtempSync(join(tmpdir(), "units-")); tmps.push(root);
  const bin = join(root, "stubs"), bundle = join(root, "bundle"), log = join(root, "systemctl.log");
  put(join(bin, "systemctl"), `#!/bin/bash\necho "$*" >>"${log}"\n[ "$1" = is-active ] && exit 0\nexit 0\n`, 0o755);
  put(join(root, "usr/bin/node"), "#!/bin/bash\n", 0o755); // hubd reuses the installed unit's ExecStart node when it exists under the root
  put(join(bin, "chown"), "#!/bin/bash\nexit 0\n", 0o755);
  put(join(bin, "mv"), '#!/bin/bash\nargs=(); for a in "$@"; do [ "$a" = -T ] || args+=("$a"); done\nexec /bin/mv "${args[@]}"\n', 0o755); // BSD mv has no -T
  mkdirSync(bundle, { recursive: true });
  copyFileSync(join(repo, "deploy", comp, "setup.sh"), join(bundle, "setup.sh"));
  put(join(bundle, `${comp}.service`), `[Service]\nExecStart=@NODE@ /opt/x/${comp}\nReadWritePaths=/var/lib/${comp} /var/lib/NEW-PATH\n`);
  put(join(bundle, "VERSION"), "9.9.9\n"); put(join(bundle, "RUNBOOK.md"), "x\n");
  const main = comp === "console" ? "app/server.js" : `${comp}.mjs`;
  put(join(bundle, main), comp === "workerd" ? 'console.log("usage: workerd")\n' : comp === "hubd" ? 'console.log("usage: hubd")\nprocess.exit(1)\n' : "// ok\n");
  const unit = join(root, "etc/systemd/system", `${comp}.service`);
  put(unit, `[Service]\nExecStart=/usr/bin/node /opt/x/${comp}\nReadWritePaths=/var/lib/${comp}\n`);
  const r = spawnSync("bash", [join(bundle, "setup.sh"), "install", "--bundle", bundle], {
    env: { PATH: `${bin}:${process.env.PATH}`, SETUP_ROOT: root, HOME: root }, encoding: "utf8",
  });
  return { r, unit: readFileSync(unit, "utf8"), calls: (() => { try { return readFileSync(log, "utf8").trim().split("\n"); } catch { return []; } })() };
}

describe("setup.sh install ships the systemd unit", () => {
  for (const comp of ["console", "hubd", "workerd"] as const) {
    it(`${comp}: a changed unit in the bundle replaces the installed one, with @NODE@ filled, and daemon-reload runs before the restart`, () => {
      const { r, unit, calls } = install(comp);
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(unit).toContain("ReadWritePaths=/var/lib/" + comp + " /var/lib/NEW-PATH");
      expect(unit).not.toContain("@NODE@");
      const reload = calls.indexOf("daemon-reload"), restart = calls.indexOf(`restart ${comp}`);
      expect(restart).toBeGreaterThan(-1);
      expect(reload).toBeGreaterThan(-1);
      expect(reload).toBeLessThan(restart);
    });
  }
});
