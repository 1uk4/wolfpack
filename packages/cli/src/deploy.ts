/**
 * `wolfpack deploy`: pure planning for a host-side release deploy (infra/release/deploy-release.sh).
 * Tag/version parsing, wolf->host resolution and the ssh argv live here (unit-tested); running ssh is injected.
 */
import { sshKeyArgs } from "./ssh-helper.js";
import type { HostEntry } from "./config.js";

export const DEPLOY_COMPONENTS = ["wolfd", "workerd", "hubd"] as const;
export type DeployComponent = (typeof DEPLOY_COMPONENTS)[number];

export interface ReleaseRef {
  component: DeployComponent;
  version: string; // X.Y.Z
  tag: string; // <component>/vX.Y.Z
}

const TAG = /^([a-z0-9]+)\/v?(\d+\.\d+\.\d+)$/;
const VER = /^v?(\d+\.\d+\.\d+)$/;

function isComponent(s: string): s is DeployComponent {
  return (DEPLOY_COMPONENTS as readonly string[]).includes(s);
}

/**
 * `--release` accepts `wolfd/v0.1.1`, `v0.1.1` or `0.1.1`. A bare version needs the component from the
 * caller (a wolf deploys wolfd; --component names hubd/workerd). A tag's own component must agree with it.
 */
export function parseReleaseRef(release: string, component?: string): ReleaseRef {
  let comp = component;
  let version: string;
  const t = TAG.exec(release);
  if (t) {
    if (component && component !== t[1]) throw new Error(`--release ${release} is a ${t[1]} tag but the component is ${component}`);
    comp = t[1];
    version = t[2]!;
  } else {
    const v = VER.exec(release);
    if (!v) throw new Error(`--release must be <component>/vX.Y.Z, vX.Y.Z or X.Y.Z, got "${release}"`);
    version = v[1]!;
  }
  if (!comp) throw new Error("cannot tell the component: use a full tag like wolfd/v0.1.1 or pass --component");
  if (!isComponent(comp)) throw new Error(`unknown component "${comp}" (${DEPLOY_COMPONENTS.join("|")})`);
  return { component: comp, version, tag: `${comp}/v${version}` };
}

export interface DeployRequest {
  wolf?: string;
  component?: string;
  release: string;
  host?: string;
  dryRun?: boolean;
  healthTimeout?: number;
  /** workerd only: link | wolves | both | auto (default). */
  unit?: string;
  /** sha256 of infra/wolves/wolfd-unit.sh (workerd wolves/both): the host warns when the live copy differs. */
  wolfdUnitSha256?: string;
}

export interface DeployPlan extends ReleaseRef {
  host: string;
  wolf?: string;
  dryRun: boolean;
  /** Arguments after the script name. */
  scriptArgs: string[];
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Host choice: --host, else the single registered host whose wolves tree has this wolf (hostsWithWolf), else the default host.
 * Note this resolves on the CLI side only; unlike `wolfpack sync` it never goes through the host agent, so it also works for
 * workerd-managed wolves (the sync 404 "Wolf not found" gap does not apply here).
 */
export function planDeploy(req: DeployRequest, ctx: { defaultHost?: string; hostsWithWolf?: string[] }): DeployPlan {
  const comp = req.component ?? (req.wolf ? "wolfd" : undefined);
  const ref = parseReleaseRef(req.release, comp);
  if (ref.component === "wolfd") {
    if (!req.wolf || !NAME.test(req.wolf)) throw new Error("deploy wolfd needs a wolf: wolfpack deploy <wolf> --release wolfd/vX.Y.Z");
  } else if (req.wolf) {
    throw new Error(`${ref.component} is a host component: use --component ${ref.component} --host <host>, not a wolf name`);
  }
  let host = req.host;
  if (!host && ref.component === "wolfd") {
    const found = ctx.hostsWithWolf ?? [];
    if (found.length > 1) throw new Error(`wolf ${req.wolf} exists on several hosts (${found.join(", ")}): pass --host`);
    host = found[0];
  }
  host = host ?? ctx.defaultHost;
  if (!host || host === "local") throw new Error("deploy needs a remote host: pass --host <host> (or set a default host)");
  const scriptArgs = [ref.component, ref.version];
  if (ref.component === "wolfd") scriptArgs.push("--wolf", req.wolf!);
  if (req.unit !== undefined) {
    if (ref.component !== "workerd") throw new Error("--unit only applies to --component workerd");
    if (!["link", "wolves", "both"].includes(req.unit)) throw new Error("--unit must be link (default), wolves or both");
    scriptArgs.push("--unit", req.unit);
    if (req.wolfdUnitSha256 && (req.unit === "wolves" || req.unit === "both")) scriptArgs.push("--wolfd-unit-sha256", req.wolfdUnitSha256);
  }
  if (req.healthTimeout !== undefined) {
    if (!Number.isInteger(req.healthTimeout) || req.healthTimeout < 1) throw new Error("--health-timeout must be a positive integer (seconds)");
    scriptArgs.push("--health-timeout", String(req.healthTimeout));
  }
  if (req.dryRun) scriptArgs.push("--dry-run");
  return { ...ref, host, wolf: req.wolf, dryRun: !!req.dryRun, scriptArgs };
}

const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/;

/** POSIX single-quote a word for the remote shell. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function assertSafeSshField(what: string, v: string): void {
  if (!SAFE_TOKEN.test(v) || v.startsWith("-")) throw new Error(`refusing ssh ${what} ${JSON.stringify(v)}: must match ^[A-Za-z0-9._-]+$ and not start with "-"`);
}

/**
 * ssh argv that runs the script from stdin as root: no scp, no copy left on the host, nothing to keep in sync.
 * The destination is validated (no leading "-", no shell/ssh-option characters; IPv6 literals are not supported, use a name),
 * `--` precedes it, and every script arg is shell-quoted.
 */
export function buildSshArgv(host: HostEntry, scriptArgs: string[]): string[] {
  assertSafeSshField("user", host.ssh.user);
  assertSafeSshField("address", host.address);
  const sudo = host.ssh.user === "root" ? "" : "sudo ";
  return [
    ...sshKeyArgs(host.ssh.key),
    "-p",
    String(host.ssh.port),
    "-o",
    "BatchMode=yes",
    "--",
    `${host.ssh.user}@${host.address}`,
    `${sudo}bash -s -- ${scriptArgs.map(shellQuote).join(" ")}`,
  ];
}
