/** POST /v1/wolves/:name/new-feature: starts the work-creation flow with THIS wolf's resolved prompts. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

async function boot(overrides: Record<string, string> = {}) {
  const wolfHome = mkdtempSync(join(tmpdir(), "wolfd-newfeature-"));
  dirs.push(wolfHome);
  mkdirSync(join(wolfHome, "agent", "prompts"), { recursive: true });
  for (const [id, text] of Object.entries(overrides)) writeFileSync(join(wolfHome, "agent", "prompts", `${id}.md`), text);
  const s = new WolfServer({ name: "w", wolfHome, conversation: new ScriptedEngine({ delayMs: 1, id: "900" }) });
  servers.push(s);
  await s.attach();
  return `${await s.listen()}/v1`;
}
const post = (url: string, body: unknown) => fetch(url, { method: "POST", body: JSON.stringify(body) });

describe("wolfd /new-feature", () => {
  it("starts the home thread with this wolf's overridden new-work and stage prompts, plus the idea", async () => {
    const base = await boot({ "new-work": "MARKER-NEW-WORK\n{{grilling}}\n{{toSpec}}", grilling: "MARKER-GRILLING" });
    const res = await post(`${base}/wolves/w/new-feature`, { idea: "add dark mode" });
    expect(res.status).toBe(200);
    const ack = await res.json();
    expect(ack.threadId).toBe("w/home");
    const thread = await (await fetch(`${base}/threads/${encodeURIComponent(ack.threadId)}`)).json();
    const first = thread.messages.find((m: { role: string }) => m.role === "user");
    const text = JSON.stringify(first);
    expect(text).toContain("MARKER-NEW-WORK");
    expect(text).toContain("MARKER-GRILLING");
    expect(text).toContain("The idea: add dark mode");
  });
});
