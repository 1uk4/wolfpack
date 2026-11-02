// Tracer --kb: the Work API the wolf's graduation preview reads (the same local work server the sandbox uses), on loopback.
// usage: work-server.mjs <ledgerDir> <port> <token>
import { startLocalWorkServer } from "/opt/wolfpack/packages/agent/dist/index.js";
const [ledgerDir, port, token] = process.argv.slice(2);
const srv = await startLocalWorkServer({ ledgerDir, token, port: Number(port) });
console.log(`work server ${srv.url}`);
process.on("SIGTERM", () => srv.close().finally(() => process.exit(0)));
