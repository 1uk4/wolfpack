/** GET /v1/settings: the hub's prompts, masked effective config and version. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as engine from "@wolfpack/engine";
import { createHubServer, type HubServer } from "./server.js";
import { OP, seedTokens, workerHeaders } from "./testing/tokens.js";

const tmp: string[] = [];
const servers: HubServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

async function setup(opts: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hubd-settings-"));
  tmp.push(dir);
  seedTokens(dir, ["h1"]);
  const hub = await createHubServer({ dataDir: dir, kbPollMs: 0, kbSettleMs: -1, ...opts });
  servers.push(hub);
  return hub;
}

type S = { version: string; prompts: { id: string; group: string; label: string; text: string }[]; config: Record<string, unknown> };

describe("hub settings", () => {
  it("401 without a token", async () => {
    const hub = await setup();
    expect((await fetch(`${hub.url}/v1/settings`)).status).toBe(401);
  });

  it("lists every engine prompt the KB sweep uses, with the exact running text", async () => {
    const hub = await setup();
    const r = await fetch(`${hub.url}/v1/settings`, { headers: OP });
    expect(r.status).toBe(200);
    const s = (await r.json()) as S;
    const byId = new Map(s.prompts.map((p) => [p.id, p]));
    // The sweep's engine.call sites (kb/src/librarian oracles.ts, produce.ts, summarize.ts) pass these constants as `system`.
    const used = {
      "sweep.produce": engine.PRODUCE_SYSTEM,
      "sweep.contradict": engine.CONTRADICT_SYSTEM,
      "sweep.section-pick": engine.SECTION_PICK_SYSTEM,
      "sweep.match-subject": engine.MATCH_SUBJECT_SYSTEM,
      "sweep.confirm-subject": engine.CONFIRM_SUBJECT_SYSTEM,
      "sweep.section-summary": engine.SECTION_SUMMARY_SYSTEM,
      "sweep.label-section": engine.LABEL_SECTION_SYSTEM,
      "sweep.split-section": engine.SPLIT_SECTION_SYSTEM,
    };
    for (const [id, text] of Object.entries(used)) {
      expect(byId.get(id)?.text, id).toBe(text);
      expect(byId.get(id)?.group).toBe("KB sweep");
      expect(byId.get(id)?.label).not.toBe("");
    }
    expect(s.prompts).toHaveLength(Object.keys(used).length);
  });

  it("the prompt list covers every system prompt the sweep source passes to engine.call", () => {
    // Fails when a new `system: X_SYSTEM` appears in the sweep path without being listed in the settings.
    const kb = join(__dirname, "..", "..", "kb", "src", "librarian");
    const found = new Set<string>();
    for (const f of ["oracles.ts", "produce.ts", "summarize.ts"]) {
      for (const m of readFileSync(join(kb, f), "utf8").matchAll(/system: ([A-Z_]+_SYSTEM)\b/g)) found.add(m[1]!);
    }
    expect([...found].sort()).toEqual(
      ["CONFIRM_SUBJECT_SYSTEM", "CONTRADICT_SYSTEM", "LABEL_SECTION_SYSTEM", "MATCH_SUBJECT_SYSTEM", "PRODUCE_SYSTEM", "SECTION_PICK_SYSTEM", "SECTION_SUMMARY_SYSTEM", "SPLIT_SECTION_SYSTEM"],
    );
  });

  it("masks secrets in the config and never returns their value", async () => {
    const hub = await setup({
      ollama: { url: "http://127.0.0.1:11434", model: "nomic-embed-text", apiKey: "sk-super-secret-value" },
      curator: { enabled: false, pollMs: 1234, modelsFile: "/etc/models.json", authToken: "tok-super-secret" },
    });
    const r = await fetch(`${hub.url}/v1/settings`, { headers: OP });
    const raw = await r.text();
    expect(raw).not.toContain("sk-super-secret-value");
    expect(raw).not.toContain("tok-super-secret");
    const s = JSON.parse(raw) as S;
    const c = s.config as { ollama: Record<string, unknown>; curator: Record<string, unknown> };
    expect(c.ollama.apiKey).toEqual({ set: true });
    expect(c.curator.authToken).toEqual({ set: true });
    expect(c.ollama.model).toBe("nomic-embed-text");
    expect(c.curator.pollMs).toBe(1234);
  });

  it("reports the hubd version (unstamped checkout: <package.json>-dev)", async () => {
    const hub = await setup();
    const s = (await (await fetch(`${hub.url}/v1/settings`, { headers: OP })).json()) as S;
    expect(s.version).toBe("0.1.0-dev");
  });

  it("refuses a worker token", async () => {
    const hub = await setup();
    const r = await fetch(`${hub.url}/v1/settings`, { headers: workerHeaders("h1") });
    expect(r.status).toBe(403);
  });
});
