#!/usr/bin/env node
/**
 * Standalone local Work server.
 *
 * Usage: wolfpack-work-server --ledger-dir <dir> [--port <n>] [--token <t>]
 *   --port   default 0 (ephemeral); the chosen URL is printed
 *   --token  default $WORK_TOKEN
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
  console.error("usage: wolfpack-work-server --ledger-dir <dir> [--port <n>] [--token <t> | $WORK_TOKEN]");
  process.exit(2);
}

startLocalWorkServer({
  ledgerDir,
  token,
  port: values.port ? parseInt(values.port, 10) : 0,
  host: values.host,
})
  .then((s) => console.log(`wolfpack-work-server listening on ${s.url} (ledger ${ledgerDir})`))
  .catch((err) => {
    console.error("Failed to start wolfpack-work-server:", err);
    process.exit(1);
  });
