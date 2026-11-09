import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { healthShapeProblems } from "@wolfpack/protocol/stub";
import { ScriptedEngine } from "./scripted-engine.js";
import { WolfServer } from "./server.js";

const servers: WolfServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

it("wolfd answers GET /healthz without a token, with service, version, uptime and event-loop lag", async () => {
  const s = new WolfServer({ name: "w", conversation: new ScriptedEngine({ delayMs: 1, id: "900" }) });
  servers.push(s);
  await s.attach();
  const res = await fetch(`${await s.listen()}/healthz`);
  expect(res.status).toBe(200);
  const b = (await res.json()) as { wolf: string };
  expect(healthShapeProblems(b, "wolfd", `${(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version}-dev`)).toEqual([]); // unstamped checkout: <package.json>-dev
  expect(b.wolf).toBe("w");
});
