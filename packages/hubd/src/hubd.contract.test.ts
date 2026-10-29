/** The /v1 contract (transport checks) and the hub suite against a real hubd on port 0 with a temp, fixture-seeded data dir. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { runContractSuite, runHubSuite } from "@wolfpack/protocol/contract";
import { createHubServer, type HubServer } from "./server.js";
import { seedFixture, FIXTURE_DOMAIN } from "./testing/fixture.js";

const KEY = "test-hub-key";
const dataDir = mkdtempSync(join(tmpdir(), "hubd-contract-"));
let hub: HubServer;
let url = "";
let feature = { id: "", title: "", kind: "" };
beforeAll(async () => {
  feature = seedFixture(dataDir).feature;
  hub = await createHubServer({ dataDir, apiKey: KEY, port: 0 });
  url = hub.url;
});
afterAll(async () => {
  await hub.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const headers = { "X-API-Key": KEY };
// hubd is not a wolf host: the wolf-runtime groups are skipped, the transport checks (unknown routes, protocol version) run.
runContractSuite(() => url, { wolfRuntime: false, headers });
runHubSuite(() => url, { headers, domain: FIXTURE_DOMAIN, record: () => feature });
