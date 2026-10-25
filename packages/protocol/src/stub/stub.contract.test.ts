import { afterAll, beforeAll } from "vitest";
import { runContractSuite } from "../contract/index.js";
import { StubServer } from "./index.js";

const stub = new StubServer({ delayMs: 15 });
let url = "";
beforeAll(async () => {
  url = await stub.listen();
});
afterAll(() => stub.close());

runContractSuite(() => url);
