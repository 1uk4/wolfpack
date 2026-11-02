#!/usr/bin/env node
/**
 * workerd --wolves <dir> --port N [--only name]...
 * Supervises one wolfd per wolf under <dir> and serves the /v1 protocol for all of them on one port.
 */
import { parseServeArgs } from "../cli-args.js";
import { pairWithHub } from "../hub-config.js";
import { runWorkerd } from "../run.js";

const USAGE = "usage: workerd pair <hub-url> <code>\n       workerd [--wolves <dir>] [--port N] [--host H] [--only name]... [--wolfd <command>] [--wolfd-transport socket|tcp]\n       workerd --link-only --announce <wolf>... [--host 127.0.0.1] [--port N]   (hub link + KB sync only; spawns no wolfd)";

async function main(): Promise<void> {
  if (process.argv[2] === "pair") {
    const [url, code] = process.argv.slice(3);
    if (!url || !code) {
      console.error("usage: workerd pair <hub-url> <code>");
      process.exit(2);
    }
    const cfg = await pairWithHub(url, code);
    console.log(`workerd: paired with ${cfg.hubUrl} as host ${cfg.hostId}`);
    return;
  }
  const parsed = parseServeArgs(process.argv.slice(2));
  if ("help" in parsed) {
    console.log(USAGE);
    return;
  }
  if ("error" in parsed) {
    console.error(`workerd: ${parsed.error}`);
    process.exit(2);
  }
  const w = await runWorkerd(parsed.opts);
  console.log(`workerd: serving ${w.url} (${w.supervisor.wolves().length} wolves)`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    w.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(`workerd: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
