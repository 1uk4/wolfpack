#!/usr/bin/env node
/**
 * workerd --wolves <dir> --port N [--only name]...
 * Supervises one wolfd per wolf under <dir> and serves the /v1 protocol for all of them on one port.
 */
import { parseArgs } from "node:util";
import { KB_COMPARE_USAGE, runKbCompare } from "../kb-compare.js";
import { pairWithHub } from "../hub-config.js";
import { runWorkerd } from "../run.js";

const USAGE = "usage: workerd pair <hub-url> <code>\n       " + KB_COMPARE_USAGE.replace("usage: ", "") + "\n       workerd [--wolves <dir>] [--port N] [--only name]... [--wolfd <command>]";

async function main(): Promise<void> {
  if (process.argv[2] === "kb-compare") process.exit(runKbCompare(process.argv.slice(3)));
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
  const { values } = parseArgs({
    options: {
      wolves: { type: "string", short: "w" },
      port: { type: "string", short: "p" },
      only: { type: "string", multiple: true },
      wolfd: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const port = values.port === undefined ? 7141 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`workerd: invalid --port ${values.port}`);
    process.exit(2);
  }
  const w = await runWorkerd({
    wolvesDir: values.wolves,
    port,
    only: values.only,
    command: values.wolfd ? values.wolfd.split(/\s+/) : undefined,
  });
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
