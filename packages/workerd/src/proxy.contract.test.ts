import { afterAll, beforeAll } from "vitest";
import { runContractSuite } from "@wolfpack/protocol/contract";
import { StubServer } from "@wolfpack/protocol/stub";
import { WorkerdServer } from "./proxy.js";
import { staticRegistry } from "./registry.js";

/**
 * The /v1 contract run against workerd's PROXIED base URL, with a protocol StubServer as the upstream wolf
 * (registry injected). Proves the proxy preserves contract semantics end to end.
 */
const stub = new StubServer({ delayMs: 15 });
let proxy: WorkerdServer;
let url = "";
beforeAll(async () => {
  const upstream = await stub.listen();
  proxy = new WorkerdServer({ registry: staticRegistry({ "1uk4": upstream, hal: upstream }) });
  url = await proxy.listen();
});
afterAll(async () => {
  await proxy.close();
  await stub.close();
});

runContractSuite(() => url);
