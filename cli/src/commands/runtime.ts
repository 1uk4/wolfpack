import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { findWolf, inventoryPath, loadWolves, type Wolf, type WolfRuntime } from "@wolfpack/core";
import { c, table } from "../render.ts";

const VALID_RUNTIMES: WolfRuntime[] = ["pi", "claude"];

export async function runtimeCommand(
  args: { name?: string; target?: string; json?: boolean },
): Promise<void> {
  const wolves = loadWolves();

  // No args → list every wolf and its runtime.
  if (!args.name) {
    if (args.json) {
      process.stdout.write(
        JSON.stringify(wolves.map((w) => ({ name: w.name, runtime: w.runtime })), null, 2) + "\n",
      );
      return;
    }
    if (wolves.length === 0) {
      console.log("No wolves in inventory.");
      return;
    }
    const rows = wolves.map((w) => [
      c.bold(w.name),
      w.runtime === "pi" ? c.cyan("pi") : "claude",
    ]);
    console.log(table(["WOLF", "RUNTIME"], rows));
    return;
  }

  const wolf = findWolf(wolves, args.name);
  if (!wolf) {
    console.error(`Unknown wolf: ${args.name}. Known: ${wolves.map((w) => w.name).join(", ")}`);
    process.exit(1);
  }

  // One arg → show current runtime.
  if (!args.target) {
    if (args.json) {
      process.stdout.write(JSON.stringify({ name: wolf.name, runtime: wolf.runtime }, null, 2) + "\n");
      return;
    }
    console.log(`${wolf.name} runtime: ${c.bold(wolf.runtime)}`);
    return;
  }

  // Two args → switch.
  if (!VALID_RUNTIMES.includes(args.target as WolfRuntime)) {
    console.error(`Invalid runtime: ${args.target}. Must be one of: ${VALID_RUNTIMES.join(", ")}`);
    process.exit(1);
  }
  const target = args.target as WolfRuntime;

  if (target === wolf.runtime) {
    console.log(`${wolf.name} is already on '${wolf.runtime}' — nothing to do`);
    return;
  }

  await switchRuntime(wolf, target);
}

async function switchRuntime(wolf: Wolf, target: WolfRuntime): Promise<void> {
  const invPath = inventoryPath();
  const invText = readFileSync(invPath, "utf8");

  // Compute the new wolf_config_dir when it follows the .../wolves/<name>/<runtime>
  // convention. For anything else (or unset), leave it alone.
  const currentCfg = extractCurrentValue(invText, wolf.hostKey, "wolf_config_dir");
  let nextCfg: string | undefined;
  if (currentCfg) {
    const m = currentCfg.match(/^(.*)\/(pi|claude)$/);
    if (m) {
      nextCfg = `${m[1]}/${target}`;
    } else {
      console.warn(
        c.yellow(
          `⚠️  wolf_config_dir (${currentCfg}) doesn't follow the .../<runtime> convention.\n` +
            `   Leaving it as-is. Edit inventory manually if the target runtime needs a different path.`,
        ),
      );
    }
  }

  // Show the plan.
  console.log("");
  console.log(c.bold(`Switch ${wolf.name}: ${wolf.runtime} → ${target}`));
  console.log(c.dim(`  inventory:      ${invPath}`));
  console.log(c.dim(`  wolf_runtime:   ${wolf.runtime} → ${target}`));
  if (nextCfg && currentCfg) {
    console.log(c.dim(`  wolf_config_dir: ${currentCfg} → ${nextCfg}`));
  }
  console.log(c.dim(`  then:           ansible-playbook playbooks/redeploy.yml --limit ${wolf.name}`));
  console.log("");
  console.log(
    c.yellow(
      "This ends the wolf's current tmux session. The den is runtime-agnostic\n" +
        "so memory + identity survive, but DM the wolf first to checkpoint if\n" +
        "it's mid-task.",
    ),
  );
  console.log("");

  // Confirm by typing the wolf name.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Type '${wolf.name}' to continue (or Ctrl-C to abort): `);
  rl.close();
  if (answer.trim() !== wolf.name) {
    console.log("aborted");
    process.exit(1);
  }

  // Apply inventory edits.
  let nextInv = replaceInventoryValue(invText, wolf.hostKey, "wolf_runtime", target);
  if (nextCfg) {
    nextInv = replaceInventoryValue(nextInv, wolf.hostKey, "wolf_config_dir", nextCfg);
  }
  writeFileSync(invPath, nextInv);
  console.log(c.green(`  ✓ inventory updated`));
  console.log("");

  // Shell out to ansible with stdio inherited so the user sees it live.
  const code = await runAnsible(wolf.name);
  if (code !== 0) {
    console.error(
      c.red(
        `\nansible-playbook exited ${code}. Inventory was updated; check the errors above and re-run:\n` +
          `  ansible-playbook playbooks/redeploy.yml --limit ${wolf.name}`,
      ),
    );
    process.exit(code);
  }
  console.log("");
  console.log(c.green(`✓ ${wolf.name} switched to ${target}`));
  console.log(c.dim(`  verify: ./wolfpack status ${wolf.name}`));
}

// Regex mirrors bootstrap.sh's approach: find the host block, then the nearest
// key: value line inside it. Preserves surrounding formatting and comments.
function hostKeyRegex(hostKey: string, field: string): RegExp {
  const escapedHost = hostKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^\\s*${escapedHost}:\\s*\\n(?:\\s+[^\\n]*\\n)*?\\s+${field}:\\s*)\\S+`,
    "m",
  );
}

function extractCurrentValue(inv: string, hostKey: string, field: string): string | undefined {
  const re = new RegExp(
    `^\\s*${hostKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*\\n(?:\\s+[^\\n]*\\n)*?\\s+${field}:\\s*(\\S+)`,
    "m",
  );
  return inv.match(re)?.[1];
}

function replaceInventoryValue(inv: string, hostKey: string, field: string, value: string): string {
  const re = hostKeyRegex(hostKey, field);
  const next = inv.replace(re, `$1${value}`);
  if (next === inv) {
    throw new Error(
      `could not find '${field}:' under host '${hostKey}' in inventory — expected format is a top-level key with '${field}: <value>' nested under it`,
    );
  }
  return next;
}

function runAnsible(wolfName: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      "ansible-playbook",
      ["playbooks/redeploy.yml", "--limit", wolfName],
      { stdio: "inherit" },
    );
    child.on("error", (err) => {
      console.error(c.red(`Failed to spawn ansible-playbook: ${err.message}`));
      console.error(c.dim("Install ansible on your Mac: brew install ansible"));
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? -1));
  });
}
