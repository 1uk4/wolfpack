/** The /v1 contract (transport checks) and the hub suite against a real hubd on port 0 with a temp, fixture-seeded data dir. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { runContractSuite, runHubSuite } from "@wolfpack/protocol/contract";
import { createHubServer, type HubServer } from "./server.js";
import { standardCast } from "./testing/tokens.js";
import { seedFixture, FIXTURE_DOMAIN } from "./testing/fixture.js";

const dataDir = mkdtempSync(join(tmpdir(), "hubd-contract-"));
let hub: HubServer;
let url = "";
const operator: Record<string, string> = {};
const wolf: Record<string, string> = {};
const wolf2: Record<string, string> = {};
let feature = { id: "", title: "", kind: "" };
beforeAll(async () => {
  feature = seedFixture(dataDir).feature;
  mkdirSync(join(dataDir, "kb", "base"), { recursive: true });
  writeFileSync(join(dataDir, "kb", "base", "domains.yaml"), `domains:\n  ${FIXTURE_DOMAIN}:\n    label: Fixture\n`);
  hub = await createHubServer({ dataDir, port: 0 });
  url = hub.url;
  const cast = await standardCast(hub, FIXTURE_DOMAIN);
  Object.assign(operator, cast.operator);
  Object.assign(wolf, cast.wolf);
  Object.assign(wolf2, cast.wolf2);
});
afterAll(async () => {
  await hub.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// hubd is not a wolf host: the wolf-runtime groups are skipped, the transport checks (unknown routes, protocol version) run.
runContractSuite(() => url, { wolfRuntime: false, headers: operator });
runHubSuite(() => url, { operator, wolf, wolf2, domain: FIXTURE_DOMAIN, record: () => feature });
