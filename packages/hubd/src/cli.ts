#!/usr/bin/env node
/** hubd CLI: `hubd serve` and `hubd dev`. The API key comes from env HUBD_API_KEY only (never argv, never logged). */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHubServer } from "./server.js";
import { assertNotLiveMirror, assertSafeDevDataDir, defaultDevDataDir, snapshotState, takeSnapshot } from "./snapshot.js";

export interface CliArgs {
  command: "serve" | "dev";
  dataDir?: string;
  port: number;
  host: string;
  snapshot?: string;
  allowNetwork: boolean;
}

export const MIN_KEY_LENGTH = 16;
/** Strict: `localhost`, `::1`/`[::1]`, or a dotted-quad 127.x.y.z with every octet <= 255. DNS names such as 127.evil.com are NOT loopback. */
export const isLoopback = (h: string): boolean => {
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  if (!/^127(\.\d{1,3}){3}$/.test(h)) return false;
  return h.split(".").every((o) => Number(o) <= 255);
};

const USAGE = `usage:
  hubd serve --data-dir <dir> [--port N] [--host 127.0.0.1]
  hubd dev --snapshot <host> [--data-dir <dir>] [--port N] [--allow-network]    pull a read-only copy of <host>, then serve it
  hubd dev --data-dir <dir> [--port N]                        re-serve an earlier snapshot (no pull)
env: HUBD_API_KEY (required, >= 16 chars)
--host other than loopback needs "dev --allow-network" (dev serves production data copies)`;

export function parseArgs(argv: string[]): CliArgs {
  const [command, ...rest] = argv;
  if (command !== "serve" && command !== "dev") throw new Error(USAGE);
  const out: CliArgs = { command, port: 3142, host: "127.0.0.1", allowNetwork: false };
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
    else if (flag === "--allow-network" && command === "dev") out.allowNetwork = true;
    else if (flag === "--port") {
      const raw = val();
      const p = /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error("--port must be an integer from 1 to 65535");
      out.port = p;
    } else throw new Error(`unknown argument ${flag}\n${USAGE}`);
  }
  if (command === "serve" && !out.dataDir) throw new Error("serve requires --data-dir");
  if (command === "dev" && !out.snapshot && !out.dataDir) throw new Error("dev requires --snapshot <host> or --data-dir <existing snapshot>");
  if (command === "dev" && !isLoopback(out.host) && !out.allowNetwork) throw new Error(`refusing to bind dev mode (production data copy) to non-loopback host ${out.host} without --allow-network`);
  return out;
}

export async function main(argv: string[], env = process.env, log: (m: string) => void = console.log) {
  const args = parseArgs(argv);
  const apiKey = env.HUBD_API_KEY;
  if (!apiKey) throw new Error("HUBD_API_KEY is not set");
  if (apiKey.length < MIN_KEY_LENGTH) throw new Error(`HUBD_API_KEY must be at least ${MIN_KEY_LENGTH} characters`);
  if (args.command === "dev" && !isLoopback(args.host))
    log(`!!! WARNING: dev mode is binding to ${args.host} (--allow-network). This serves a COPY OF PRODUCTION DATA to the network, protected only by the shared API key. !!!`);
  let dataDir: string;
  if (args.command === "dev") {
    dataDir = assertSafeDevDataDir(args.dataDir ?? defaultDevDataDir());
    if (args.snapshot) {
      log(`hubd dev: pulling read-only snapshot of ${args.snapshot} into ${dataDir}`);
      const m = await takeSnapshot({ host: args.snapshot, dataDir });
      log(`hubd dev: snapshot ok (${m.fileCount} files, ledger sha256 ${m.ledgerSha256.slice(0, 12)})`);
    } else {
      const state = snapshotState(dataDir);
      if (state === "none") throw new Error(`${dataDir} has no DEV-SNAPSHOT marker; refusing to treat it as a dev snapshot`);
      if (state === "incomplete") throw new Error(`${dataDir} is an INCOMPLETE snapshot (a pull did not finish); re-run \`hubd dev --snapshot <host> --data-dir ${dataDir}\` to retry, or use a fresh dir`);
    }
  } else dataDir = assertNotLiveMirror(args.dataDir!); // serve: no live mirror/den; /var/wolfpack is allowed (VPS hub)
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
