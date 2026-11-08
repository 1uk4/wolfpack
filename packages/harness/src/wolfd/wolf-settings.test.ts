/** /v1/wolves/:name/settings: masked read, env names, reveal, validated atomic write, restart. */
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWolfConfig } from "@wolfpack/engine";
import { composeProjectContext } from "./context.js";
import { ScriptedEngine } from "./scripted-engine.js";
import { WolfServer } from "./server.js";

const dirs: string[] = [];
const servers: WolfServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const YAML = `name: w
domains: [personal]
subagents:
  maxRunning: 3
compaction:
  enabled: true
memory:
  consolidation:
    threshold: 20000
  hubToken: yaml-secret-value
`;

async function boot(extra: { restart?: () => void; uptimeMs?: () => number } = {}) {
  const wolfHome = mkdtempSync(join(tmpdir(), "wolfd-settings-"));
  dirs.push(wolfHome);
  const configFile = join(wolfHome, "wolf.yaml");
  writeFileSync(configFile, YAML);
  const env = { WORK_TOKEN: "env-secret-value", WORK_ENDPOINT: "http://work.example", WOLFPACK_HUB_URL: undefined };
  const s = new WolfServer({ name: "w", wolfHome, configFile, env, conversation: new ScriptedEngine({ delayMs: 1, id: "900" }), ...extra });
  servers.push(s);
  await s.attach();
  return { wolfHome, configFile, url: `${await s.listen()}/v1/wolves/w/settings` };
}
const send = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("wolfd /settings", () => {
  it("reads wolf.yaml with secrets masked and reports env var names without values", async () => {
    const { url } = await boot();
    const res = await send(url, "GET");
    const text = await res.text();
    expect(text).not.toContain("yaml-secret-value");
    expect(text).not.toContain("env-secret-value");
    const v = JSON.parse(text);
    expect(v.config.subagents.maxRunning).toBe(3);
    expect(v.config.memory.hubToken).toEqual({ set: true });
    expect(v.env.find((e: { name: string }) => e.name === "WORK_TOKEN")).toMatchObject({ set: true, secret: true });
    expect(v.env.find((e: { name: string }) => e.name === "WORK_ENDPOINT")).toMatchObject({ set: true, secret: false });
    expect(v.env.find((e: { name: string }) => e.name === "WOLFPACK_HUB_URL")).toMatchObject({ set: false });
    expect(v.restartNeeded).toBe(false);
  });

  it("reveals exactly one listed value and refuses names it does not list", async () => {
    const { url } = await boot();
    const ok = await send(`${url}/reveal`, "POST", { source: "env", name: "WORK_TOKEN" });
    expect(await ok.json()).toEqual({ name: "WORK_TOKEN", value: "env-secret-value" });
    const cfg = await send(`${url}/reveal`, "POST", { source: "config", name: "memory.hubToken" });
    expect(await cfg.json()).toEqual({ name: "memory.hubToken", value: "yaml-secret-value" });
    // A name the masked read does not mask is already in the GET body: no reveal.
    expect((await send(`${url}/reveal`, "POST", { source: "config", name: "subagents.maxRunning" })).status).toBe(404);
    expect((await send(`${url}/reveal`, "POST", { source: "env", name: "PATH" })).status).toBe(404);
    // Inherited properties are not settings.
    expect((await send(`${url}/reveal`, "POST", { source: "config", name: "constructor" })).status).toBe(404);
  });

  it("writes a validated edit atomically, says a restart is needed and keeps comments out of the way of other keys", async () => {
    const { url, wolfHome, configFile } = await boot();
    const before = await (await send(url, "GET")).json();
    const put = await send(url, "PUT", { set: { "subagents.maxRunning": 5, "compaction.enabled": null } }, { "If-Match": before.etag });
    expect(put.status).toBe(200);
    const after = await put.json();
    expect(after.restartNeeded).toBe(true);
    expect(after.config.subagents.maxRunning).toBe(5);
    expect(after.config.compaction).toBeUndefined();
    expect(readFileSync(configFile, "utf8")).toContain("maxRunning: 5");
    expect(readdirSync(wolfHome).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("answers 400 for a bad value or a non-editable key, 409 for a stale etag, and leaves the file untouched", async () => {
    const { url, configFile } = await boot();
    const v = await (await send(url, "GET")).json();
    const bad = await send(url, "PUT", { set: { "subagents.maxRunning": 0 } }, { "If-Match": v.etag });
    expect(bad.status).toBe(400);
    expect((await send(url, "PUT", { set: { "memory.live": true } }, { "If-Match": v.etag })).status).toBe(400);
    expect((await send(url, "PUT", { set: { "subagents.maxRunning": 4 } }, { "If-Match": "stale" })).status).toBe(409);
    expect(readFileSync(configFile, "utf8")).toBe(YAML);
    expect(existsSync(configFile + ".tmp")).toBe(false);
  });

  it("saves the wolf color only as a palette key, reports it on the wolf summary, and null clears it", async () => {
    const { url, configFile } = await boot();
    const summary = async () => (await (await fetch(url.replace("/wolves/w/settings", "/wolves"))).json()).wolves[0].color;
    const put = async (value: unknown) => {
      const v = await (await send(url, "GET")).json();
      return send(url, "PUT", { set: { color: value } }, { "If-Match": v.etag });
    };
    expect((await put("pink")).status).toBe(200);
    expect(readFileSync(configFile, "utf8")).toContain("color: pink");
    expect(await summary()).toBe("pink");
    for (const bad of ["chartreuse", 7, ""]) expect((await put(bad)).status).toBe(400);
    expect(await summary()).toBe("pink");
    expect((await put(null)).status).toBe(200);
    expect(await summary()).toBeUndefined();
    expect(readFileSync(configFile, "utf8")).not.toContain("color");
  });

  it("requires If-Match on a write (400 without it) and leaves the file untouched", async () => {
    const { url, configFile } = await boot();
    const res = await send(url, "PUT", { set: { "subagents.maxRunning": 4 } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_request");
    expect(readFileSync(configFile, "utf8")).toBe(YAML);
  });

  it("answers 400 for a wolf.yaml with a syntax error and does not echo its content", async () => {
    const { url, configFile } = await boot();
    const v = await (await send(url, "GET")).json();
    writeFileSync(configFile, "name: [unclosed\nsecret-line: hunter2: x\n");
    const res = await send(url, "PUT", { set: { "subagents.maxRunning": 4 } }, { "If-Match": (await (await send(url, "GET")).json()).etag });
    expect(v.etag).toBeDefined();
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("hunter2");
  });

  it("backs up wolf.yaml before each write and keeps the newest 10", async () => {
    const { url, wolfHome } = await boot();
    for (let i = 1; i <= 12; i++) {
      const v = await (await send(url, "GET")).json();
      expect((await send(url, "PUT", { set: { "subagents.maxRunning": i } }, { "If-Match": v.etag })).status).toBe(200);
    }
    const dir = join(wolfHome, "agent", ".backups", "config");
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(10);
    expect(files.every((f) => /^wolf\.\d{17,}\.yaml$/.test(f))).toBe(true);
    expect(readFileSync(join(dir, files[0]!), "utf8")).toContain("maxRunning: 2");
    expect(readFileSync(join(dir, files[9]!), "utf8")).toContain("maxRunning: 11");
  });

  it("keeps the file mode and writes through a symlink instead of replacing it", async () => {
    const { url, configFile, wolfHome } = await boot();
    const real = join(wolfHome, "real.yaml");
    renameSync(configFile, real);
    chmodSync(real, 0o640);
    symlinkSync(real, configFile);
    const v = await (await send(url, "GET")).json();
    expect((await send(url, "PUT", { set: { "subagents.maxRunning": 6 } }, { "If-Match": v.etag })).status).toBe(200);
    expect(lstatSync(configFile).isSymbolicLink()).toBe(true);
    expect(statSync(real).mode & 0o777).toBe(0o640);
    expect(readFileSync(real, "utf8")).toContain("maxRunning: 6");
  });

  it("refuses restart when nothing supervises wolfd, and restarts when something does", async () => {
    const off = await boot();
    const refused = await send(`${off.url}/restart`, "POST");
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("conflict");
    let called = 0;
    const on = await boot({ restart: () => void (called += 1), uptimeMs: () => 61_000 });
    expect(await (await send(`${on.url}/restart`, "POST")).json()).toEqual({ restarting: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(called).toBe(1);
  });

  it("refuses a restart within 60s of start with 429 and a retry time, and reports the wait in the view", async () => {
    let called = 0;
    const { url } = await boot({ restart: () => void (called += 1), uptimeMs: () => 10_000 });
    const res = await send(`${url}/restart`, "POST");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("50");
    expect(await res.json()).toMatchObject({ code: "rate_limited", details: { retryAfterSeconds: 50 }, retryable: true });
    expect((await (await send(url, "GET")).json()).restartAvailableInSeconds).toBe(50);
    await new Promise((r) => setTimeout(r, 50));
    expect(called).toBe(0);
  });

  it("reports no wait once the process has been up past the cooldown", async () => {
    const { url } = await boot({ restart: () => {}, uptimeMs: () => 61_000 });
    expect((await (await send(url, "GET")).json()).restartAvailableInSeconds).toBe(0);
  });

  it("sets, removes (false) and clears prompts.structuredOutput; the composed prompt follows after a restart", async () => {
    const { configFile, wolfHome, url } = await boot();
    const compose = () => {
      const cfg = loadWolfConfig(configFile).config;
      return composeProjectContext({ name: "w", cwd: wolfHome, den: wolfHome, home: wolfHome, structuredOutput: cfg.prompts?.structuredOutput }).blocks.find((b) => b.id === "structured-output")?.text;
    };
    const put = async (value: unknown) => {
      const etag = (await (await send(url, "GET")).json()).etag;
      return send(url, "PUT", { set: { "prompts.structuredOutput": value } }, { "If-Match": etag });
    };
    expect((await (await send(url, "GET")).json()).editable).toContain("prompts.structuredOutput");
    expect((await put("Use graphs always.")).status).toBe(200);
    expect(compose()).toBe("# Structured output\n\nUse graphs always.");
    expect((await put(false)).status).toBe(200);
    expect(compose()).toBeUndefined();
    expect((await put(null)).status).toBe(200);
    expect(compose()).toContain("show_decision");
    expect(readFileSync(configFile, "utf8")).not.toContain("prompts");
    expect((await put(5)).status).toBe(400);
  });
});
