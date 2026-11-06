/** POST /v1/contributions wiring: a wolf may not hint a domain it is not subscribed to; an operator may. */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentHash } from "@wolfpack/kb/shared";
import { contributionsDir } from "./layout.js";
import { createHubServer, type HubServer } from "./server.js";
import { bearer, mintOperatorToken, registerWolfOnHost } from "./testing/tokens.js";

const dataDir = mkdtempSync(join(tmpdir(), "hubd-domainhint-"));
let hub: HubServer;
let operator: Record<string, string>;
let hal: Record<string, string>;
beforeAll(async () => {
  hub = await createHubServer({ dataDir });
  operator = bearer(mintOperatorToken(dataDir));
  const json = { "Content-Type": "application/json", ...operator };
  for (const name of ["personal", "wolfpack"]) await fetch(`${hub.url}/v1/registry/domains`, { method: "POST", headers: json, body: JSON.stringify({ name }) });
  hal = await registerWolfOnHost(hub, operator, "hal2", "h-hal2", { domains: ["personal"] });
});
afterAll(async () => {
  await hub.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const post = (body: unknown, headers: Record<string, string>) =>
  fetch(`${hub.url}/v1/contributions`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const contribution = (topic: string, domainHint: string) => {
  const body = `Body of ${topic}.`;
  return { from: "hal2", denTopicId: topic, change: "create", contentHash: contentHash(body), prevHash: null, domainHint, summary: "Summary line.", submitted: "2026-10-01 12:00", body, origin: "crawl", sourcePath: "/src" };
};
const stored = () => readdirSync(contributionsDir(dataDir, "hal2")).filter((f) => f.endsWith(".md"));

describe("POST /v1/contributions domain_hint", () => {
  it("accepts a wolf's subscribed domain", async () => {
    expect((await post(contribution("own", "personal"), hal)).status).toBe(201);
  });
  it("refuses a foreign domain from the wolf, and stores nothing for it", async () => {
    const res = await post(contribution("foreign", "wolfpack"), hal);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/subscribed domains/);
    expect(stored()).toHaveLength(1);
  });
  it("accepts the same hint from an operator", async () => {
    expect((await post(contribution("op", "wolfpack"), operator)).status).toBe(201);
    expect(stored()).toHaveLength(2);
  });
});
