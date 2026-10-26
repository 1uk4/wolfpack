import { afterAll, beforeAll, expect, it } from "vitest";
import { runContractSuite } from "../contract/index.js";
import { StubServer } from "./index.js";

const stub = new StubServer({ delayMs: 15 });
let url = "";
beforeAll(async () => {
  url = await stub.listen();
});
afterAll(() => stub.close());

runContractSuite(() => url);

it("stub: memory actions answer the exact memory_unavailable envelope", async () => {
  const wolf = ((await (await fetch(`${url}/v1/wolves`)).json()) as { wolves: { name: string }[] }).wolves[0].name;
  for (const action of ["consolidate", "promote"]) {
    const res = await fetch(`${url}/v1/wolves/${wolf}/memory/${action}`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "memory_unavailable", message: "memory is not loaded on this wolf", retryable: false });
  }
});
