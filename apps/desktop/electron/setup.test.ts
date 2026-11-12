/**
 * Seams: the main-side first-run setup (electron/setup.cjs), driven from Node with temp dirs and a fake Anthropic server on 127.0.0.1.
 * Needs `node apps/desktop/scripts/build-runtime.mjs` first; WOLFPACK_DESKTOP_TEST_NODE=1 runs the children under this Node (see supervisor.test.ts).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const { checkKey, needsSetup, resolveFinishKey, runSetup } = createRequire(import.meta.url)("./setup.cjs");
const runtimeDir = join(here, "..", "runtime");

let fake: Server;
let fakeUrl: string;
let root: string;
const seenKeys: string[] = [];

/** /v1/models answers 200 for the key "sk-ok", 403 for "sk-forbidden" and 401 (Anthropic's error body) for any other. */
beforeAll(async () => {
  fake = createServer((req, res) => {
    seenKeys.push(String(req.headers["x-api-key"] ?? ""));
    const ok = req.headers["x-api-key"] === "sk-ok";
    const forbidden = req.headers["x-api-key"] === "sk-forbidden";
    const body = ok ? { data: [] } : forbidden ? { error: { type: "permission_error", message: "API access is disabled" } } : { error: { type: "authentication_error", message: "invalid x-api-key" } };
    res.writeHead(ok ? 200 : forbidden ? 403 : 401, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  root = mkdtempSync(join(tmpdir(), "app-setup-"));
});
afterAll(async () => {
  await new Promise((r) => fake?.close(r));
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("key check", () => {
  it("accepts a key Anthropic accepts", async () => {
    expect(await checkKey("sk-ok", { baseUrl: fakeUrl })).toEqual({ ok: true });
  });

  it("passes on Anthropic's reason for a 401 and a 403, and falls back when there is none", async () => {
    expect(await checkKey("sk-bad", { baseUrl: fakeUrl })).toEqual({ ok: false, error: "Anthropic didn't accept this key: invalid x-api-key" });
    expect(await checkKey("sk-forbidden", { baseUrl: fakeUrl })).toEqual({ ok: false, error: "This key isn't allowed to use the API: API access is disabled" });
    const bare = async () => new Response("not json", { status: 401 });
    expect(await checkKey("sk-bad", { fetchImpl: bare })).toEqual({ ok: false, error: "That key didn't work" });
    // A key echoed past the 200-character cut must still be caught: the reason is dropped, not shown with the key's tail.
    const echo = async () => new Response(JSON.stringify({ error: { message: `${"x ".repeat(120)}invalid key sk-echoed-secret` } }), { status: 401 });
    expect(await checkKey("sk-echoed-secret", { fetchImpl: echo })).toEqual({ ok: false, error: "That key didn't work" });
  });

  it("says it could not reach Anthropic when the network fails", async () => {
    expect(await checkKey("sk-ok", { baseUrl: "http://127.0.0.1:1" })).toEqual({ ok: false, error: "Couldn't reach Anthropic" });
  });

  it("never sends the key to a plain-http, non-loopback base URL", async () => {
    seenKeys.length = 0;
    // 0.0.0.0 reaches the fake server on this Mac but is not on the loopback list; the fallback is a dead port so nothing real is called.
    const url = fakeUrl.replace("127.0.0.1", "0.0.0.0");
    expect(await checkKey("sk-ok", { baseUrl: url, fallbackBase: "http://127.0.0.1:1" })).toEqual({ ok: false, error: "Couldn't reach Anthropic" });
    expect(seenKeys).toEqual([]);
  });
});

const nodeBin = process.env.WOLFPACK_DESKTOP_TEST_NODE === "1" ? process.execPath : "";

describe("setup answers", () => {
  it("rejects a bad domain, a reserved domain, an emoji-only name and a long description with nothing written", async () => {
    const base = { apiKey: "sk-ok", wolfName: "Maya" };
    const stateDir = join(root, "validate-state");
    const wolvesDir = join(root, "validate-wolves");
    const opts = { stateDir, wolvesDir, runtimeDir, nodeBin, modelBaseUrl: fakeUrl };
    const rejects: [string, object][] = [
      ["Domain \"my recipes\": Use 1-32 lower-case letters and digits.", { ...base, domains: [{ name: "my recipes", description: "" }] }],
      ["Domain \"registry\": \"registry\" is reserved.", { ...base, domains: [{ name: "registry", description: "" }] }],
      ["Give your wolf a name with at least one letter or digit.", { ...base, wolfName: "🐺", domains: [] }],
      ["Domain \"long\": keep the description to 140 characters.", { ...base, domains: [{ name: "long", description: "x".repeat(141) }] }],
    ];
    for (const [message, answers] of rejects) await expect(runSetup(answers, opts)).rejects.toThrow(message);
    expect(existsSync(stateDir)).toBe(false);
    expect(existsSync(wolvesDir)).toBe(false);
  });
});

describe("first-run setup", () => {
  it("a start that fails leaves setup undone; a retry then succeeds, drops the duplicate domain, adds personal and seeds the chosen domains", async () => {
    const stateDir = join(root, "retry-state");
    const wolvesDir = join(root, "retry-wolves");
    const answers = { apiKey: "sk-ok", wolfName: "Retry", domains: [{ name: "recipes", description: "Dinners" }, { name: "recipes", description: "again" }] };
    await expect(runSetup(answers, { stateDir, wolvesDir, runtimeDir: join(root, "no-such-runtime"), nodeBin, modelBaseUrl: fakeUrl })).rejects.toThrow();
    expect(needsSetup(stateDir)).toBe(true);

    const sup = await runSetup(answers, { stateDir, wolvesDir, runtimeDir, nodeBin, modelBaseUrl: fakeUrl });
    try {
      expect(needsSetup(stateDir)).toBe(false);
      expect(JSON.parse(readFileSync(join(stateDir, "setup.json"), "utf8"))).toEqual({ complete: true, wolf: "retry", wolfName: "Retry", domains: [{ name: "personal", description: "" }, { name: "recipes", description: "Dinners" }] });
      // See below: the hub API needs a token the test does not have before pairing.
      const reg = JSON.parse(readFileSync(join(stateDir, "hub", "registry", "registry.json"), "utf8"));
      expect(reg.domains.map((d: { name: string }) => d.name)).toEqual(["personal", "recipes"]);
    } finally {
      await sup.stop();
    }
  }, 120_000);

  it("reuses a wolf folder: the domains its wolf.yaml already lists are kept and seeded with the chosen ones", async () => {
    const stateDir = join(root, "reuse-state");
    const wolvesDir = join(root, "reuse-wolves");
    mkdirSync(join(wolvesDir, "mayas-wolf"), { recursive: true });
    const yamlPath = join(wolvesDir, "mayas-wolf", "wolf.yaml");
    writeFileSync(yamlPath, ["id: mayas-wolf", "name: mayas-wolf", `domains: [personal, "recipes"]`, `workspace: ${join(wolvesDir, "mayas-wolf", "workspace")}`, "extensions: [memory]", "memory:", "  live: true", "  defaultDomain: personal", ""].join("\n"));
    const sup = await runSetup(
      { apiKey: "sk-ok", wolfName: "Maya's Wolf", domains: [{ name: "personal", description: "" }, { name: "garden", description: "Beds" }] },
      { stateDir, wolvesDir, runtimeDir, nodeBin, modelBaseUrl: fakeUrl },
    );
    try {
      expect(readFileSync(yamlPath, "utf8")).toContain("domains: [personal, recipes, garden]");
      const reg = JSON.parse(readFileSync(join(stateDir, "hub", "registry", "registry.json"), "utf8"));
      expect(reg.domains.map((d: { name: string }) => d.name)).toEqual(["personal", "recipes", "garden"]);
      expect(JSON.parse(readFileSync(join(stateDir, "setup.json"), "utf8")).domains.map((d: { name: string }) => d.name)).toEqual(["personal", "recipes", "garden"]);
    } finally {
      await sup.stop();
    }
  }, 120_000);

  it("a start that fails after hubd seeded sets the new registry aside, so a retry with another domain seeds only that domain", async () => {
    const stateDir = join(root, "late-state");
    const wolvesDir = join(root, "late-wolves");
    // A runtime whose workerd dies at once: hubd starts and seeds, then the start fails.
    const badRuntime = join(root, "late-runtime");
    mkdirSync(badRuntime);
    for (const f of readdirSync(runtimeDir)) if (f !== "workerd.mjs") symlinkSync(join(runtimeDir, f), join(badRuntime, f));
    writeFileSync(join(badRuntime, "workerd.mjs"), "process.exit(1);\n");
    const first = { apiKey: "sk-ok", wolfName: "Late", domains: [{ name: "recipes", description: "" }] };
    await expect(runSetup(first, { stateDir, wolvesDir, runtimeDir: badRuntime, nodeBin, modelBaseUrl: fakeUrl })).rejects.toThrow();
    expect(existsSync(join(stateDir, "hub", "registry", "registry.json"))).toBe(false);
    expect(readdirSync(stateDir).some((n) => n.startsWith("failed-setup-"))).toBe(true);

    const sup = await runSetup({ ...first, domains: [{ name: "garden", description: "" }] }, { stateDir, wolvesDir, runtimeDir, nodeBin, modelBaseUrl: fakeUrl });
    try {
      const reg = JSON.parse(readFileSync(join(stateDir, "hub", "registry", "registry.json"), "utf8"));
      // Setup made the folder on attempt 1, so the retry's domains replace recipes everywhere.
      expect(reg.domains.map((d: { name: string }) => d.name)).toEqual(["personal", "garden"]);
      expect(readFileSync(join(wolvesDir, "late", "wolf.yaml"), "utf8")).toContain("domains: [personal, garden]");
      expect(JSON.parse(readFileSync(join(stateDir, "setup.json"), "utf8")).domains.map((d: { name: string }) => d.name)).toEqual(["personal", "garden"]);
    } finally {
      await sup.stop();
    }
  }, 120_000);

  it("rejects a pre-existing wolf.yaml with a block domains list when a domain must be added, writing nothing", async () => {
    const stateDir = join(root, "block-state");
    const wolvesDir = join(root, "block-wolves");
    mkdirSync(join(wolvesDir, "blocky"), { recursive: true });
    writeFileSync(join(wolvesDir, "blocky", "wolf.yaml"), ["id: blocky", "domains:", "  - personal", ""].join("\n"));
    await expect(
      runSetup({ apiKey: "sk-ok", wolfName: "Blocky", domains: [{ name: "garden", description: "" }] }, { stateDir, wolvesDir, runtimeDir, nodeBin, modelBaseUrl: fakeUrl }),
    ).rejects.toThrow("has a domains list the app can't update");
    expect(existsSync(join(stateDir, "credentials.json"))).toBe(false);
    expect(existsSync(join(stateDir, "hub"))).toBe(false);
  });

  it("starts nothing before setup, then runs the chosen wolf with its domains and a 0600 credential store", async () => {
    const stateDir = join(root, "state");
    const wolvesDir = join(root, "Wolves");
    expect(needsSetup(stateDir)).toBe(true);
    expect(existsSync(join(stateDir, "hub"))).toBe(false);

    const sup = await runSetup(
      { apiKey: "sk-ok", wolfName: "Maya's Wolf", domains: [{ name: "personal", description: "" }, { name: "recipes", description: "Family dinners" }] },
      { stateDir, wolvesDir, runtimeDir, nodeBin, modelBaseUrl: fakeUrl },
    );
    try {
      expect(needsSetup(stateDir)).toBe(false);
      expect(statSync(join(stateDir, "credentials.json")).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(join(stateDir, "credentials.json"), "utf8"))).toEqual({ ANTHROPIC_API_KEY: "sk-ok" });
      const wolves = (await (await fetch(`${sup.urls.workerd}/v1/wolves`)).json()).wolves;
      expect(wolves.map((w: { name: string }) => w.name)).toEqual(["mayas-wolf"]);
      const yaml = readFileSync(join(wolvesDir, "mayas-wolf", "wolf.yaml"), "utf8");
      expect(yaml).toContain("domains: [personal, recipes]");
      // Side-channel read: the hub API needs a token this test does not have (the supervisor keeps its own), so read the seeded registry file.
      const reg = JSON.parse(readFileSync(join(stateDir, "hub", "registry", "registry.json"), "utf8"));
      expect(reg.domains.map((d: { name: string; description?: string }) => [d.name, d.description])).toEqual([["personal", undefined], ["recipes", "Family dinners"]]);
      expect(reg.subscriptions).toEqual([{ wolf: "mayas-wolf", domain: "personal" }, { wolf: "mayas-wolf", domain: "recipes" }]);
    } finally {
      await sup.stop();
    }
  }, 120_000);

  it("finishes setup with the key skipped: complete, and a 0600 credential store with no key in it", async () => {
    const stateDir = join(root, "state-skip");
    const sup = await runSetup({ apiKey: "", wolfName: "No Key", domains: [] }, { stateDir, wolvesDir: join(root, "Wolves-skip"), runtimeDir, nodeBin, modelBaseUrl: fakeUrl });
    try {
      expect(needsSetup(stateDir)).toBe(false);
      expect(statSync(join(stateDir, "credentials.json")).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(join(stateDir, "credentials.json"), "utf8"))).toEqual({});
    } finally {
      await sup.stop();
    }
  }, 120_000);

  it("Skip with a stored key that no longer works completes without re-checking it, and keeps it as it is", async () => {
    const stateDir = join(root, "state-skip-dead");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "credentials.json"), JSON.stringify({ ANTHROPIC_API_KEY: "sk-dead" }), { mode: 0o600 });
    let checks = 0;
    const fetchImpl = async () => (checks++, new Response("{}", { status: 401 }));
    // Without skipKey the dead stored key is re-checked and refuses (the old Finish behaviour).
    expect((await resolveFinishKey({ apiKey: "" }, { stateDir, fetchImpl })).ok).toBe(false);
    checks = 0;
    const k = await resolveFinishKey({ skipKey: true, apiKey: "" }, { stateDir, fetchImpl });
    expect(k).toEqual({ ok: true, key: "" });
    expect(checks).toBe(0);
    const sup = await runSetup({ apiKey: k.key, wolfName: "Dead Key", domains: [] }, { stateDir, wolvesDir: join(root, "Wolves-skip-dead"), runtimeDir, nodeBin, modelBaseUrl: fakeUrl });
    try {
      expect(needsSetup(stateDir)).toBe(false);
      expect(JSON.parse(readFileSync(join(stateDir, "credentials.json"), "utf8"))).toEqual({ ANTHROPIC_API_KEY: "sk-dead" });
    } finally {
      await sup.stop();
    }
  }, 120_000);
});
