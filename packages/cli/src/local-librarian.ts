/**
 * Local librarian provisioning (macOS).
 *
 * When the librarian runs on the hub machine it writes the hub's KB base
 * directly, so there's no Syncthing between librarian and hub. The only moving
 * parts are: the kb-engine CLI, Ollama for embeddings, and a launchd timer that
 * runs the sweep on a schedule (the local equivalent of the VPS systemd timer).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  findRepoRoot,
  bundleKbCli,
  KB_EMBED_MODEL,
} from "./deployer.js";
import { kbBaseDir, librarianDir, type CliConfig } from "./config.js";
import { c } from "./render.js";

const SWEEP_INTERVAL_S = 900; // 15 min, matching the VPS timer

const kbCliPath = () => path.join(os.homedir(), ".wolfpack", "bin", "wolfpack-kb.cjs");
const plistPath = (name: string) =>
  path.join(os.homedir(), "Library", "LaunchAgents", `com.wolfpack.${name}-kb-sweep.plist`);
const sweepLog = (name: string) =>
  path.join(os.homedir(), ".wolfpack", "logs", `${name}-kb-sweep.log`);

/** Best-effort check that Ollama is installed, running, and has the embed model. */
function ensureOllama(): { ok: boolean; note?: string } {
  try {
    execFileSync("ollama", ["--version"], { stdio: "ignore" });
  } catch {
    return { ok: false, note: "Ollama not installed. Install it: brew install ollama (then `ollama serve`)." };
  }
  try {
    const tags = execFileSync("ollama", ["list"], { encoding: "utf8" });
    if (!tags.includes(KB_EMBED_MODEL)) {
      console.log(c.dim(`  pulling ${KB_EMBED_MODEL}…`));
      execFileSync("ollama", ["pull", KB_EMBED_MODEL], { stdio: "inherit" });
    }
    return { ok: true };
  } catch {
    return { ok: false, note: "Ollama installed but not running. Start it: `ollama serve` (or launch the app)." };
  }
}

/**
 * Provision (or refresh) a local librarian. Idempotent: rebundles the kb CLI,
 * (re)writes + loads the launchd timer. Returns notes to surface to the user.
 */
export async function installLocalLibrarian(
  config: CliConfig,
  wolf: { id: string; name: string },
): Promise<{ notes: string[] }> {
  const notes: string[] = [];
  if (process.platform !== "darwin") {
    notes.push("Local librarian scheduling is implemented for macOS (launchd) only.");
  }

  // 1. Bundle the kb-engine CLI to a stable path.
  const repoRoot = findRepoRoot();
  if (!repoRoot) throw new Error("Could not find wolfpack repo root for the KB CLI bundle.");
  fs.mkdirSync(path.dirname(kbCliPath()), { recursive: true });
  await bundleKbCli(repoRoot, kbCliPath());

  // 2. Ollama + embed model.
  const ollama = ensureOllama();
  if (!ollama.ok && ollama.note) notes.push(ollama.note);

  // 3. KB storage roots live on the hub (shared, authoritative).
  const kbBase = kbBaseDir(config);
  const kbOps = librarianDir(config);
  const denLocal = path.join(config.wolvesRoot, "local", wolf.name, "den", "kb");
  const wolfDen = path.join(config.wolvesRoot, "local", wolf.name, "den");
  for (const d of [kbBase, kbOps, denLocal]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.dirname(sweepLog(wolf.name)), { recursive: true });

  // 4. launchd timer (the local systemd-timer equivalent).
  const node = process.execPath;
  const envFile = path.join(os.homedir(), ".wolfpack", ".env");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.wolfpack.${wolf.name}-kb-sweep</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string><string>-lc</string>
    <string>set -a; [ -f ${envFile} ] && . ${envFile}; set +a; exec ${node} ${kbCliPath()} sweep</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>KB_BASE</key><string>${kbBase}</string>
    <key>KB_OPS</key><string>${kbOps}</string>
    <key>KB_DEN_LOCAL</key><string>${denLocal}</string>
    <key>WOLF_DEN</key><string>${wolfDen}</string>
    <key>WOLFPACK_EMBED_URL</key><string>http://127.0.0.1:11434</string>
  </dict>
  <key>StartInterval</key><integer>${SWEEP_INTERVAL_S}</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${sweepLog(wolf.name)}</string>
  <key>StandardErrorPath</key><string>${sweepLog(wolf.name)}</string>
</dict>
</plist>
`;
  const pp = plistPath(wolf.name);
  fs.mkdirSync(path.dirname(pp), { recursive: true });
  fs.writeFileSync(pp, plist);

  // 5. (Re)load into launchd.
  if (process.platform === "darwin") {
    try {
      execFileSync("launchctl", ["unload", pp], { stdio: "ignore" });
    } catch {
      /* not loaded yet */
    }
    try {
      execFileSync("launchctl", ["load", pp], { stdio: "ignore" });
      notes.push(`Sweep timer loaded (every ${SWEEP_INTERVAL_S / 60} min). Log: ${sweepLog(wolf.name)}`);
    } catch (err) {
      notes.push(`Could not load launchd timer: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { notes };
}

/** Run one sweep now (manual trigger for a local librarian). */
export function runLocalSweepNow(config: CliConfig, wolfName: string): void {
  const node = process.execPath;
  const denLocal = path.join(config.wolvesRoot, "local", wolfName, "den", "kb");
  const env = {
    ...process.env,
    KB_BASE: kbBaseDir(config),
    KB_OPS: librarianDir(config),
    KB_DEN_LOCAL: denLocal,
    WOLF_DEN: path.join(config.wolvesRoot, "local", wolfName, "den"),
    WOLFPACK_EMBED_URL: process.env.WOLFPACK_EMBED_URL ?? "http://127.0.0.1:11434",
  };
  execFileSync(node, [kbCliPath(), "sweep"], { stdio: "inherit", env });
}
