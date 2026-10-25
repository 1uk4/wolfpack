#!/usr/bin/env node
/**
 * wolfd --config <wolf.yaml> [--socket <path> | --port N]
 * Runs ONE wolf serving the /v1 protocol and prints `wolfd: <name> serving <url>` (http://127.0.0.1:N or unix:<path>).
 * Listener precedence: --socket > --port > serve.port (explicit TCP in wolf.yaml) > serve.socket (config value or
 * its default ~/.wolfpack/run/<name>.sock). serve.socket always resolves, so the final fallback is always a socket.
 */
import { parseArgs } from "node:util";
import { loadWolfConfig } from "@wolfpack/engine";
import { startWolf } from "../wolfd/run.js";

const USAGE = "usage: wolfd --config <wolf.yaml> [--socket <path> | --port N]";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { config: { type: "string", short: "c" }, port: { type: "string", short: "p" }, socket: { type: "string", short: "s" }, help: { type: "boolean", short: "h" } },
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
  let socket = values.socket;
  if (socket === undefined && port === undefined) {
    const { config } = loadWolfConfig(values.config);
    if (config.serve.port === undefined) socket = config.serve.socket;
  }
  const wolf = await startWolf({ configPath: values.config, port: socket ? undefined : port, socket, log: (l) => console.error(`[wolfd] ${l}`) });
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
