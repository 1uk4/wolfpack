/**
 * wolfpack deploy <wolf> --release <wolfd/vX.Y.Z|vX.Y.Z|X.Y.Z> [--host h] [--dry-run] [--health-timeout s]
 * wolfpack deploy --component hubd|workerd --release <tag|version> --host <h> [--dry-run]
 * Runs infra/release/deploy-release.sh on the host over ssh (script piped on stdin) and streams its output.
 * The host downloads the GitHub release, verifies sha256, switches, health-checks and rolls back by itself.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, getHost, type CliConfig, type HostEntry } from "../config.js";
import { buildSshArgv, planDeploy, type DeployRequest } from "../deploy.js";
import { c } from "../render.js";

export type SshRunner = (argv: string[], stdin: string) => Promise<number>;

export function defaultSshRunner(argv: string[], stdin: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn("ssh", argv, { stdio: ["pipe", "inherit", "inherit"] });
    p.on("error", (e) => {
      console.error(c.red(`ssh failed: ${e.message}`));
      resolve(255);
    });
    p.on("close", (code) => resolve(code ?? 1));
    p.stdin.end(stdin);
  });
}

export function scriptPath(): string {
  // packages/cli/dist/commands/deploy.js (or src/commands/deploy.ts) -> repo root
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../infra/release/deploy-release.sh");
}

export interface DeployDeps {
  config?: CliConfig;
  run?: SshRunner;
  readScript?: () => string;
  hostsWithWolf?: (config: CliConfig, wolf: string) => string[];
  log?: (s: string) => void;
}

function hostsHavingWolf(config: CliConfig, wolf: string): string[] {
  return Object.keys(config.hosts).filter((h) => fs.existsSync(path.join(config.wolvesRoot, h, wolf)));
}

/** Returns the exit code of the host script (0 ok, 3 rolled back, 4 rollback unhealthy, 1 refused). */
export async function deployCmd(req: DeployRequest, deps: DeployDeps = {}): Promise<number> {
  const config = deps.config ?? loadConfig();
  const log = deps.log ?? ((s: string) => console.log(s));
  const plan = planDeploy(req, {
    defaultHost: config.defaultHost,
    hostsWithWolf: req.wolf ? (deps.hostsWithWolf ?? hostsHavingWolf)(config, req.wolf) : [],
  });
  const host: HostEntry | undefined = getHost(config, plan.host);
  if (!host) throw new Error(`Host '${plan.host}' not found. Run \`wolfpack host list\`.`);
  const argv = buildSshArgv(host, plan.scriptArgs);
  log(`${c.bold("deploy")} ${plan.tag}${plan.wolf ? ` -> ${plan.wolf}` : ""} @${plan.host}${plan.dryRun ? " (dry run: the host only prints its plan)" : ""}`);
  const script = (deps.readScript ?? (() => fs.readFileSync(scriptPath(), "utf8")))();
  const code = await (deps.run ?? defaultSshRunner)(argv, script);
  const msg: Record<number, string> = {
    0: "done",
    1: "refused or failed before anything changed",
    3: "FAILED health check; rolled back to the previous release (unit healthy again)",
    4: "FAILED and the rollback is unhealthy: needs a human",
  };
  log(code === 0 ? c.green(`✓ ${msg[0]}`) : c.red(`✗ exit ${code}: ${msg[code] ?? "deploy script failed"}`));
  return code;
}
