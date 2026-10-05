/**
 * wolfpack add wolf <name> [--host <host>]
 *
 * Local (no --host): creates wolf directory in ~/wolves/
 * Remote (--host):   sends create request to agent on that host
 */

import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { stringify as yamlStringify } from "yaml";
import { AgentClient } from "../agent-client.js";
import { loadConfig, getHost } from "../config.js";
import { c } from "../render.js";

interface AddWolfOpts {
  host?: string;
  runtime?: string;
  model?: string;
  role?: string;
  specialty?: string;
  domains?: string[];
}

export async function wolfAdd(name: string, opts: AddWolfOpts): Promise<void> {
  if (opts.host) {
    await addRemote(name, opts);
  } else {
    addLocal(name, opts);
  }
}

/** Create wolf locally in ~/wolves/ */
function addLocal(name: string, opts: AddWolfOpts): void {
  const config = loadConfig();
  const id = nanoid(6);
  const wolfDir = path.join(config.wolfsDir, name);

  if (fs.existsSync(wolfDir)) {
    console.error(c.red(`Wolf directory already exists: ${wolfDir}`));
    process.exit(1);
  }

  console.log(c.bold(`Creating local wolf: ${name} (${id})`));

  // Create directory structure
  const dirs = ["den", "den/memory", "den/tasks", "logs"];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(wolfDir, dir), { recursive: true });
  }

  // Write wolf.yaml
  const wolfConfig = {
    id,
    name,
    runtime: opts.runtime ?? "pi",
    model: opts.model ?? "claude-sonnet-4-6",
    role: opts.role ?? name,
    specialty: opts.specialty,
    domains: opts.domains ?? [],
  };
  fs.writeFileSync(
    path.join(wolfDir, "wolf.yaml"),
    yamlStringify(wolfConfig),
  );

  // Write .env template
  fs.writeFileSync(
    path.join(wolfDir, ".env"),
    `WOLF_ID=${id}\nWOLF_NAME=${name}\n`,
  );

  console.log(c.green(`✓ Wolf created at ${wolfDir}`));
  console.log(c.dim(`  ID:      ${id}`));
  console.log(c.dim(`  Config:  ${path.join(wolfDir, "wolf.yaml")}`));
}

/** Create wolf on a remote host via agent */
async function addRemote(name: string, opts: AddWolfOpts): Promise<void> {
  const config = loadConfig();
  const host = getHost(config, opts.host);

  if (!host) {
    console.error(c.red(`Host '${opts.host}' not found. Run \`wolfpack host list\`.`));
    process.exit(1);
  }

  console.log(c.bold(`Creating wolf '${name}' on ${opts.host}...`));

  const client = new AgentClient(host);

  try {
    const result = (await client.createWolf({
      name,
      runtime: opts.runtime ?? "pi",
      model: opts.model ?? "claude-sonnet-4-6",
      role: opts.role ?? name,
      specialty: opts.specialty,
      domains: opts.domains ?? [],
    })) as { wolf: { id: string; name: string } };

    console.log(c.green(`✓ Wolf created on ${opts.host}`));
    console.log(c.dim(`  ID:   ${result.wolf.id}`));
    console.log(c.dim(`  Name: ${result.wolf.name}`));
  } catch (err) {
    console.error(c.red(`Failed: ${err}`));
    process.exit(1);
  }
}
