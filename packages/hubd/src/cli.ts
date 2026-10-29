#!/usr/bin/env node
/** hubd CLI: `hubd serve` and `hubd dev`. The API key comes from env HUBD_API_KEY only (never argv, never logged). */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHubServer } from "./server.js";
import { assertSafeDataDir, defaultDevDataDir, isDevSnapshot, takeSnapshot } from "./snapshot.js";

export interface CliArgs {
  command: "serve" | "dev";
  dataDir?: string;
  port: number;
  host: string;
  snapshot?: string;
}

const USAGE = `usage:
  hubd serve --data-dir <dir> [--port N] [--host 127.0.0.1]
  hubd dev --snapshot <host> [--data-dir <dir>] [--port N]    pull a read-only copy of <host>, then serve it
  hubd dev --data-dir <dir> [--port N]                        re-serve an earlier snapshot (no pull)
env: HUBD_API_KEY (required)`;

export function parseArgs(argv: string[]): CliArgs {
  const [command, ...rest] = argv;
  if (command !== "serve" && command !== "dev") throw new Error(USAGE);
  const out: CliArgs = { command, port: 3142, host: "127.0.0.1" };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    const val = () => {
      const v = rest[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === "--data-dir") out.dataDir = val();
    else if (flag === "--host") out.host = val();
    else if (flag === "--snapshot" && command === "dev") out.snapshot = val();
    else if (flag === "--port") {
      const p = Number(val());
      if (!Number.isInteger(p) || p < 0 || p > 65535) throw new Error("--port must be 0-65535");
      out.port = p;
    } else throw new Error(`unknown argument ${flag}\n${USAGE}`);
  }
  if (command === "serve" && !out.dataDir) throw new Error("serve requires --data-dir");
  if (command === "dev" && !out.snapshot && !out.dataDir) throw new Error("dev requires --snapshot <host> or --data-dir <existing snapshot>");
  return out;
}

export async function main(argv: string[], env = process.env, log: (m: string) => void = console.log) {
  const args = parseArgs(argv);
  const apiKey = env.HUBD_API_KEY;
  if (!apiKey) throw new Error("HUBD_API_KEY is not set");
  let dataDir: string;
  if (args.command === "dev") {
    dataDir = assertSafeDataDir(args.dataDir ?? defaultDevDataDir());
    if (args.snapshot) {
      log(`hubd dev: pulling read-only snapshot of ${args.snapshot} into ${dataDir}`);
      const m = await takeSnapshot({ host: args.snapshot, dataDir });
      log(`hubd dev: snapshot ok (${m.fileCount} files, ledger sha256 ${m.ledgerSha256.slice(0, 12)})`);
    } else if (!isDevSnapshot(dataDir)) throw new Error(`${dataDir} has no DEV-SNAPSHOT marker; refusing to treat it as a dev snapshot`);
  } else dataDir = args.dataDir!;
  const hub = await createHubServer({ dataDir, apiKey, port: args.port, host: args.host });
  if (args.command === "dev") log("hubd dev: DEV MODE. Writes are local-only to this snapshot and are NEVER pushed back to the source host.");
  log(`hubd listening on ${hub.url} (data dir ${dataDir})`);
  const stop = () => void hub.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
