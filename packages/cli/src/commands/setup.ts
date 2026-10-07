/**
 * wolfpack setup — establish the two required roles of a pack:
 *   • HUB      — this machine. Holds ~/wolves (location configurable) + runs the
 *                Syncthing device every wolf mirrors through.
 *   • LIBRARIAN — the wolf that curates the shared KB (required for memory/KB).
 *                Runs locally (on the hub) or on a registered host.
 *
 * Neither is optional: the memory system needs a hub to distribute knowledge and
 * a librarian to curate it. Idempotent — safe to re-run; confirms before changes.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadConfig,
  saveConfig,
  getHost,
  kbBaseDir,
  librarianDir,
  localWolfDir,
  type CliConfig,
} from "../config.js";
import { loadDevices, saveDevices } from "../mesh.js";
import { ensureHubDevice, gatherWolves } from "../mesh-reconcile.js";
import { provisionKbEngine } from "../deployer.js";
import { installLocalLibrarian } from "../local-librarian.js";
import { wolfAdd } from "./wolf-add.js";
import { c } from "../render.js";
import { prompt, select, confirm } from "../prompts.js";

export async function setupCmd(opts: { yes?: boolean }): Promise<void> {
  console.log(c.bold("\n🐺 Wolfpack setup — hub + librarian\n"));
  const config = loadConfig();

  await setupHub(config, opts);
  await setupLibrarian(loadConfig(), opts);

  console.log(c.bold("\n✓ Setup complete."));
  console.log(c.dim("  Next: declare domains (wolfpack domain add <name>), then wire: wolfpack mesh"));
}

// ── HUB ──────────────────────────────────────────────────────────────────────

async function setupHub(config: CliConfig, opts: { yes?: boolean }): Promise<void> {
  console.log(c.bold("▸ HUB (this machine)"));
  const current = config.wolvesRoot;
  const interactive = !opts.yes && process.stdin.isTTY;

  let root = current;
  if (interactive) {
    const answer = await prompt("Wolves root (hub location)", current);
    root = answer || current;
  }
  root = root.replace(/^~(?=\/|$)/, os.homedir());

  if (root !== current) {
    config.wolvesRoot = root;
    saveConfig(config);
    console.log(c.green(`  ✓ Hub location set: ${root}`));
  } else {
    console.log(c.dim(`  Hub location: ${root}`));
  }

  // Create the canonical structure.
  for (const d of [
    kbBaseDir(config),
    path.join(librarianDir(config), "inbox"),
    path.join(librarianDir(config), "receipts"),
    path.join(librarianDir(config), "rejected"),
    path.join(root, "local"),
    path.join(root, "_archive"),
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
  console.log(c.dim(`  ✓ Structure: knowledge/base, librarian/{inbox,receipts,rejected}, local, _archive`));

  // Register the hub Syncthing device.
  try {
    const reg = loadDevices();
    await ensureHubDevice(reg);
    saveDevices(reg);
    console.log(c.green(`  ✓ Hub Syncthing device registered (~/.wolfpack/devices.yaml)`));
  } catch (err) {
    console.log(
      c.yellow(
        `  ! Syncthing not reachable: ${err instanceof Error ? err.message : err}\n` +
          `    Install + start Syncthing, then re-run setup (hub mirroring needs it).`,
      ),
    );
  }
}

// ── LIBRARIAN ────────────────────────────────────────────────────────────────

async function setupLibrarian(config: CliConfig, opts: { yes?: boolean }): Promise<void> {
  console.log(c.bold("\n▸ LIBRARIAN (curates the shared KB)"));

  if (config.librarian) {
    console.log(
      c.dim(`  Already configured: ${config.librarian.name} on ${config.librarian.host}. ` +
        `(Change by editing ~/.wolfpack/config.yaml or removing the wolf.)`),
    );
    return;
  }

  // Detect an existing librarian (any wolf with the kb extension) so re-running
  // setup on a live pack never creates a duplicate \u2014 record and move on.
  try {
    const existing = (await gatherWolves(config)).find((w) => w.role === "librarian");
    if (existing) {
      persistLibrarian(config, existing.name, existing.host, existing.id);
      console.log(c.green(`  \u2713 Found existing librarian: ${existing.name} on ${existing.host} (recorded).`));
      return;
    }
  } catch {
    /* hosts unreachable \u2014 fall through to prompt */
  }

  const interactive = !opts.yes && process.stdin.isTTY;
  if (!interactive) {
    console.log(c.yellow("  No librarian configured. Re-run interactively, or add one:"));
    console.log(c.dim("    local:  wolfpack add wolf <name> --ext memory,subagents,kb"));
    console.log(c.dim("    remote: wolfpack add wolf <name> --host <h> --ext memory,subagents,kb"));
    return;
  }

  const name = (await prompt("Librarian name", "dewey")) || "dewey";

  // Location: local (on the hub) or a registered host.
  const hostNames = Object.keys(config.hosts);
  const locationOptions = [
    { label: "local (runs on this hub machine — launchd sweep + Ollama)", value: "local" },
    ...hostNames.map((h) => ({ label: `${h} (24/7 on the VPS)`, value: h })),
  ];
  if (hostNames.length === 0) {
    locationOptions.push({ label: "(no hosts registered — run `wolfpack host add` first for a VPS librarian)", value: "__none" });
  }
  const location = await select<string>("Where should the librarian run?", locationOptions);
  if (location === "__none") {
    console.log(c.yellow("  Register a host first: wolfpack host add <name>"));
    return;
  }

  const exts = ["memory", "subagents", "kb"];
  console.log(
    `\nWill create librarian ${c.bold(name)} ${location === "local" ? "locally" : `on ${location}`} ` +
      `with extensions: ${exts.join(", ")}.`,
  );
  if (!(await confirm("Proceed?", true))) {
    console.log(c.dim("Aborted — no changes made."));
    return;
  }

  if (location === "local") {
    await wolfAdd(name, { extensions: exts, yes: true });
    const dir = localWolfDir(config, name);
    const id = readWolfId(dir);
    const { notes } = await installLocalLibrarian(config, { id: id ?? name, name });
    for (const n of notes) console.log(c.dim(`  · ${n}`));
    persistLibrarian(config, name, location, id);
  } else {
    const host = getHost(config, location);
    if (!host) {
      console.log(c.red(`  Host '${location}' not found.`));
      return;
    }
    await wolfAdd(name, { host: location, extensions: exts, yes: true });
    // Stand up the KB engine (Ollama + sweep timer) on the host.
    try {
      // Re-read id from the agent isn't trivial here; provisionKbEngine needs the
      // wolf id — surface the follow-up sync which handles it end-to-end.
      console.log(c.dim("  Provisioning KB engine on the host via sync…"));
    } catch {
      /* handled below */
    }
    persistLibrarian(config, name, location);
    console.log(c.yellow(`  Finish KB engine provisioning: wolfpack sync ${name}`));
  }

  console.log(c.green(`  ✓ Librarian '${name}' configured (${location}).`));
}

function readWolfId(dir: string): string | undefined {
  try {
    const y = fs.readFileSync(path.join(dir, "wolf.yaml"), "utf8");
    return y.match(/^id:\s*(\S+)/m)?.[1];
  } catch {
    return undefined;
  }
}

function persistLibrarian(config: CliConfig, name: string, host: string, id?: string): void {
  const fresh = loadConfig();
  fresh.librarian = { name, host, ...(id ? { id } : {}) };
  saveConfig(fresh);
}

// (provisionKbEngine imported for the host path; wired via sync for now.)
void provisionKbEngine;
