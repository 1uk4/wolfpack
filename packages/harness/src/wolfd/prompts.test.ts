/** /v1/wolves/:name/prompts: the per-wolf prompt overrides over HTTP. */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedEngine } from "./scripted-engine.js";
import { WolfServer } from "./server.js";

const dirs: string[] = [];
const servers: WolfServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot() {
  const wolfHome = mkdtempSync(join(tmpdir(), "wolfd-prompts-"));
  dirs.push(wolfHome);
  const s = new WolfServer({ name: "w", wolfHome, conversation: new ScriptedEngine({ delayMs: 1, id: "900" }) });
  servers.push(s);
  await s.attach();
  return { wolfHome, url: `${await s.listen()}/v1/wolves/w/prompts` };
}
const send = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("wolfd /prompts", () => {
  it("lists the registry with the repo default, then serves an override, then resets it", async () => {
    const { url } = await boot();
    const listed = await (await send(url, "GET")).json();
    const rules = listed.prompts.find((p: { id: string }) => p.id === "orchestrator-rules");
    expect(rules).toMatchObject({ group: "Orchestrator", editable: true, source: "default" });
    expect(rules.text).toContain("You are the orchestrator");
    for (const id of ["new-work", "grilling", "to-spec", "to-tickets"]) {
      expect(listed.prompts.find((p: { id: string }) => p.id === id)).toMatchObject({ group: "Work creation", editable: true, source: "default" });
    }

    const put = await send(`${url}/orchestrator-rules`, "PUT", { text: "mine" }, { "If-Match": rules.etag });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ source: "override", text: "mine" });

    const del = await send(`${url}/orchestrator-rules`, "DELETE");
    expect(await del.json()).toMatchObject({ source: "default", etag: rules.etag });
  });

  it("answers 409 for a stale etag and keeps the current text", async () => {
    const { url } = await boot();
    const first = await (await send(`${url}/orchestrator-rules`, "GET")).json();
    await send(`${url}/orchestrator-rules`, "PUT", { text: "one" });
    const stale = await send(`${url}/orchestrator-rules`, "PUT", { text: "two" }, { "If-Match": first.etag });
    expect(stale.status).toBe(409);
    expect((await (await send(`${url}/orchestrator-rules`, "GET")).json()).text).toBe("one");
  });

  it("answers 413 over the size cap, 404 for an unknown prompt, and writes atomically", async () => {
    const { url, wolfHome } = await boot();
    expect((await send(`${url}/orchestrator-rules`, "PUT", { text: "x".repeat(64 * 1024 + 1) })).status).toBe(413);
    expect((await send(`${url}/nope`, "PUT", { text: "x" })).status).toBe(404);
    expect(existsSync(join(wolfHome, "agent", "prompts"))).toBe(false);
    await send(`${url}/orchestrator-rules`, "PUT", { text: "ok" });
    expect(readdirSync(join(wolfHome, "agent", "prompts"))).toEqual(["orchestrator-rules.md"]);
  });
});
