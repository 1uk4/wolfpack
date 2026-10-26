#!/usr/bin/env node
/**
 * Standalone local Work server.
 *
 * Usage: wolfpack-work-server --ledger-dir <dir> [--port <n>] [--token <t>]
 *   --port   default 0 (ephemeral); the chosen URL is printed
 *   --token  default $WORK_TOKEN
 *   --host   interface to bind (default 127.0.0.1)
 */

import { parseArgs } from "node:util";
import { startLocalWorkServer } from "../work-server.js";

const { values } = parseArgs({
  options: {
    "ledger-dir": { type: "string" },
    port: { type: "string" },
    token: { type: "string" },
    host: { type: "string" },
  },
});

const ledgerDir = values["ledger-dir"];
const token = values.token ?? process.env.WORK_TOKEN;
if (!ledgerDir || !token) {
  console.error("usage: wolfpack-work-server --ledger-dir <dir> [--port <n>] [--token <t> | $WORK_TOKEN] [--host <h>]");
  process.exit(2);
}

const port = values.port === undefined ? 0 : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`invalid --port "${values.port}": expected an integer from 0 to 65535`);
  process.exit(2);
}

startLocalWorkServer({
  ledgerDir,
  token,
  port,
  host: values.host,
})
  .then((s) => console.log(`wolfpack-work-server listening on ${s.url} (ledger ${ledgerDir})`))
  .catch((err) => {
    console.error("Failed to start wolfpack-work-server:", err);
    process.exit(1);
  });
