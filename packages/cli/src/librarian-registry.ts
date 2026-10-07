/**
 * Deploy the declared-domain registry (~/.wolfpack/domains.yaml) to the
 * librarian's KB base, so the sweep's declared-domain GATE recognizes the
 * current set of domains.
 *
 *   • local librarian  → copy into the hub's knowledge/base (same filesystem)
 *   • remote librarian → scp into /home/wolf-<id>/knowledge/base (owned by the
 *                        wolf user) over SSH
 *
 * The registry lives at the KB-base ROOT (not inside any domains/<x>/ folder),
 * so it never mirrors out to wolves — only the librarian reads it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, getHost, kbBaseDir, type CliConfig } from "./config.js";
import { registryPath } from "./domains.js";
import { AgentClient } from "./agent-client.js";
import { scpToHost, execSsh } from "./ssh-helper.js";

export interface DeployResult {
  ok: boolean;
  note: string;
}

/**
 * Push the current domains.yaml to the configured librarian. Best-effort: returns
 * a result rather than throwing, so callers (domain add/rm, sync) can continue.
 */
export async function deployDomainsRegistry(
  config: CliConfig = loadConfig(),
): Promise<DeployResult> {
  const lib = config.librarian;
  if (!lib) return { ok: false, note: "no librarian configured (run: wolfpack setup)" };

  const src = registryPath();
  if (!fs.existsSync(src)) return { ok: false, note: "no domains.yaml yet (declare a domain first)" };
  const content = fs.readFileSync(src, "utf8");

  // Local librarian: the hub KB base IS the librarian's KB base.
  if (lib.host === "local") {
    const dest = path.join(kbBaseDir(config), "domains.yaml");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
    return { ok: true, note: `local: ${dest}` };
  }

  // Remote librarian: scp to /home/wolf-<id>/knowledge/base/domains.yaml.
  const host = getHost(config, lib.host);
  if (!host) return { ok: false, note: `host '${lib.host}' not registered` };

  let id = lib.id;
  if (!id) {
    try {
      const { wolves } = (await new AgentClient(host).listWolves()) as {
        wolves: Array<{ id: string; name: string }>;
      };
      id = wolves.find((w) => w.name === lib.name)?.id;
    } catch {
      /* fall through */
    }
  }
  if (!id) return { ok: false, note: "could not resolve librarian wolf id" };

  const user = `wolf-${id}`;
  const dest = `/home/${user}/knowledge/base/domains.yaml`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wolfpack-reg-"));
  const file = path.join(tmp, "domains.yaml");
  try {
    fs.writeFileSync(file, content);
    scpToHost(host, file, "/tmp/wolfpack-domains.yaml");
    const res = execSsh(
      host,
      `mkdir -p /home/${user}/knowledge/base && ` +
        `install -o ${user} -g ${user} -m 644 /tmp/wolfpack-domains.yaml ${dest} && ` +
        `rm -f /tmp/wolfpack-domains.yaml`,
    );
    if (res.code !== 0) return { ok: false, note: res.stderr.trim() || "ssh write failed" };
    return { ok: true, note: `${lib.host}:${dest}` };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
