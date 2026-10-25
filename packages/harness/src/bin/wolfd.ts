#!/usr/bin/env node
/**
 * wolfd --config <wolf.yaml> [--port N]
 * Runs ONE wolf serving the /v1 protocol on 127.0.0.1 (port: --port > serve.port > ephemeral) and prints the base URL.
 */
import { parseArgs } from "node:util";
import { startWolf } from "../wolfd/run.js";

const USAGE = "usage: wolfd --config <wolf.yaml> [--port N]";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { config: { type: "string", short: "c" }, port: { type: "string", short: "p" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (!values.config) {
    console.error(USAGE);
    process.exit(2);
  }
  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error(`wolfd: invalid --port ${values.port}`);
      process.exit(2);
    }
  }
  const wolf = await startWolf({ configPath: values.config, port, log: (l) => console.error(`[wolfd] ${l}`) });
  console.log(`wolfd: ${wolf.config.identity.name} serving ${wolf.url}`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    wolf.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(`wolfd: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
