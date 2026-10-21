/**
 * Hourly `wolfpack usage ingest` on the hub (macOS launchd), so the usage
 * ledger keeps up with pi sessions and mirrored stores even when nobody runs
 * `wolfpack usage`. Same shape as the local librarian's sweep timer.
 *
 * The job pins the Node that installed it (process.execPath) and puts that
 * Node first on PATH, so an nvm project's .nvmrc can't swap in Node 20
 * (node:sqlite needs 22.5+).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { binDirs } from "./paths.js";

const LABEL = "com.wolfpack.usage-ingest";
const INGEST_INTERVAL_S = 3600;

export const usagePlistPath = () => path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
export const usageIngestLog = () => path.join(os.homedir(), ".wolfpack", "logs", "usage-ingest.log");

/** The CLI entry point this module was loaded from (dist/bin/wolfpack.js). */
const cliEntry = () => fileURLToPath(new URL("./bin/wolfpack.js", import.meta.url));

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function usagePlist(node: string = process.execPath, entry: string = cliEntry()): string {
  const pathEnv = [path.dirname(node), ...binDirs(), "/usr/bin", "/bin"].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string><string>${xml(entry)}</string><string>usage</string><string>ingest</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(pathEnv)}</string>
  </dict>
  <key>StartInterval</key><integer>${INGEST_INTERVAL_S}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(usageIngestLog())}</string>
  <key>StandardErrorPath</key><string>${xml(usageIngestLog())}</string>
</dict>
</plist>
`;
}

/** Write + (re)load the hourly job. Returns notes to surface to the user. */
export function installUsageSchedule(): string[] {
  if (process.platform !== "darwin") throw new Error("The usage schedule is implemented for macOS (launchd) only.");
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) throw new Error(`Run this under Node 22+ (this is ${process.version}); the job pins the Node that installs it.`);
  const pp = usagePlistPath();
  fs.mkdirSync(path.dirname(pp), { recursive: true });
  fs.mkdirSync(path.dirname(usageIngestLog()), { recursive: true });
  fs.writeFileSync(pp, usagePlist());
  try {
    execFileSync("launchctl", ["unload", pp], { stdio: "ignore" });
  } catch {
    /* not loaded yet */
  }
  execFileSync("launchctl", ["load", pp], { stdio: "ignore" });
  return [
    `Usage ingest loaded (hourly, ${process.execPath}). Plist: ${pp}`,
    `Log: ${usageIngestLog()}`,
  ];
}

export function uninstallUsageSchedule(): string[] {
  const pp = usagePlistPath();
  if (!fs.existsSync(pp)) return ["Usage ingest schedule is not installed."];
  try {
    execFileSync("launchctl", ["unload", pp], { stdio: "ignore" });
  } catch {
    /* not loaded */
  }
  fs.rmSync(pp, { force: true });
  return [`Usage ingest schedule removed (${pp}).`];
}
