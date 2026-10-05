import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  envPath,
  findWolf,
  inventoryPath,
  loadWolves,
  type Wolf,
  type WolfRuntime,
} from "@wolfpack/core";
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

  // Two args → switch, or redeploy if already on target.
  if (!VALID_RUNTIMES.includes(args.target as WolfRuntime)) {
    console.error(`Invalid runtime: ${args.target}. Must be one of: ${VALID_RUNTIMES.join(", ")}`);
    process.exit(1);
  }
  const target = args.target as WolfRuntime;

  await switchOrRedeploy(wolf, target);
}

async function switchOrRedeploy(wolf: Wolf, target: WolfRuntime): Promise<void> {
  const invPath = inventoryPath();
  const invText = readFileSync(invPath, "utf8");
  const isSwitch = target !== wolf.runtime;

  // Load .env (repo-root) into a child env for ansible. inventory does
  // `telegram_bot_token: "{{ lookup('env', 'TELEGRAM_BOT_TOKEN_<WOLF>') }}"`
  // and ansible resolves that against its own process env — not Mac's shell.
  // Sourcing .env ourselves means `./wolfpack runtime ...` works without
  // requiring the user to `set -a; source .env; set +a` first.
  const dotenv = loadDotEnv();
  const childEnv = { ...process.env, ...dotenv };
  const missing = validateRequiredEnv(wolf, childEnv);
  if (missing.length > 0) {
    console.error(c.red(`\nMissing required env vars for ${wolf.name}:`));
    for (const key of missing) console.error(c.red(`  - ${key}`));
    console.error(
      c.dim(
        `\nAdd them to ${envPath()} (copy from .env.example if needed), then re-run.\n` +
          `Values of 'REPLACE_ME…' are treated as unset.`,
      ),
    );
    process.exit(1);
  }

  // Figure out whether the co-located config dir needs a new leaf.
  const currentCfg = extractCurrentValue(invText, wolf.hostKey, "wolf_config_dir");
  let nextCfg: string | undefined;
  if (isSwitch && currentCfg) {
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
  if (isSwitch) {
    console.log(c.bold(`Switch ${wolf.name}: ${wolf.runtime} → ${target}`));
    console.log(c.dim(`  inventory:       ${invPath}`));
    console.log(c.dim(`  wolf_runtime:    ${wolf.runtime} → ${target}`));
    if (nextCfg && currentCfg) {
      console.log(c.dim(`  wolf_config_dir: ${currentCfg} → ${nextCfg}`));
    }
  } else {
    console.log(c.bold(`Redeploy ${wolf.name} (already on ${target})`));
    console.log(c.dim(`  inventory:       unchanged`));
  }
  console.log(c.dim(`  then:            ansible-playbook playbooks/redeploy.yml --limit ${wolf.name}`));
  console.log("");
  console.log(
    c.yellow(
      isSwitch
        ? "This ends the wolf's current tmux session. The den is runtime-agnostic\n" +
            "so memory + identity survive, but DM the wolf first to checkpoint if\n" +
            "it's mid-task."
        : "Redeploy re-renders roles (channel .env, settings, hooks, unit file).\n" +
            "The wolf restarts only if any of those files change; the running tmux\n" +
            "session keeps going otherwise.",
    ),
  );
  console.log("");

  // Confirm — type the wolf name for switch, 'yes' for redeploy-in-place.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const expected = isSwitch ? wolf.name : "yes";
  const prompt = isSwitch
    ? `Type '${wolf.name}' to continue (or Ctrl-C to abort): `
    : `Redeploy ${wolf.name}? [yes/N]: `;
  const answer = await rl.question(prompt);
  rl.close();
  if (answer.trim() !== expected) {
    console.log("aborted");
    process.exit(1);
  }

  // Apply inventory edits only on a real switch.
  if (isSwitch) {
    let nextInv = replaceInventoryValue(invText, wolf.hostKey, "wolf_runtime", target);
    if (nextCfg) {
      nextInv = replaceInventoryValue(nextInv, wolf.hostKey, "wolf_config_dir", nextCfg);
    }
    writeFileSync(invPath, nextInv);
    console.log(c.green(`  ✓ inventory updated`));
    console.log("");
  }

  // Shell out to ansible with .env-merged child env.
  const code = await runAnsible(wolf.name, childEnv);
  if (code !== 0) {
    console.error(
      c.red(
        `\nansible-playbook exited ${code}. Check errors above; you can retry with:\n` +
          `  ./wolfpack runtime ${wolf.name} ${target}`,
      ),
    );
    process.exit(code);
  }
  console.log("");
  console.log(c.green(`✓ ${wolf.name} on ${target} (deploy complete)`));
  console.log(c.dim(`  verify: ./wolfpack status ${wolf.name}`));
}

// Minimal .env parser: KEY=VALUE lines, optional surrounding quotes, # comments.
// Not a full shell parser — enough for the shape of .env.example.
function loadDotEnv(): Record<string, string> {
  const p = envPath();
  if (!existsSync(p)) return {};
  const text = readFileSync(p, "utf8");
  const env: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

function tokenEnvVarName(wolfName: string): string {
  return `TELEGRAM_BOT_TOKEN_${wolfName.toUpperCase().replace(/-/g, "_")}`;
}

function validateRequiredEnv(
  wolf: Wolf,
  env: Record<string, string | undefined>,
): string[] {
  const required = [tokenEnvVarName(wolf.name)];
  if (wolf.runtime === "pi") required.push("ANTHROPIC_API_KEY");
  const missing: string[] = [];
  for (const key of required) {
    const v = env[key];
    if (!v || v.length === 0 || v.startsWith("REPLACE_ME")) {
      missing.push(key);
    }
  }
  return missing;
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

function runAnsible(wolfName: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      "ansible-playbook",
      ["playbooks/redeploy.yml", "--limit", wolfName],
      { stdio: "inherit", env },
    );
    child.on("error", (err) => {
      console.error(c.red(`Failed to spawn ansible-playbook: ${err.message}`));
      console.error(c.dim("Install ansible on your Mac: brew install ansible"));
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? -1));
  });
}
