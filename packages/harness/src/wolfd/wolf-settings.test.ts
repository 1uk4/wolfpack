/** /v1/wolves/:name/settings: masked read, env names, reveal, validated atomic write, restart. */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    expect(readdirSync(wolfHome).filter((f) => f !== "wolf.yaml")).toEqual([]);
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
