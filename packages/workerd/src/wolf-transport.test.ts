import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apiWolfNames, wolfTransport } from "./wolf-transport.js";

let root = "";
afterEach(() => root && rmSync(root, { recursive: true, force: true }));
function wolf(name: string, models?: string) {
  root ||= mkdtempSync(join(tmpdir(), "transport-"));
  mkdirSync(join(root, name), { recursive: true });
  if (models !== undefined) writeFileSync(join(root, name, "models.json"), models);
  return { file: join(root, name, "wolf.yaml"), identity: { name } } as never;
}

describe("wolfTransport", () => {
  it("reads models.json beside wolf.yaml; the wolf's own transport beats WOLF_TRANSPORT, which is only a fallback; anything undeterminable is subscription", () => {
    expect(wolfTransport(wolf("a", '{"transport":"api"}'), {})).toBe("api");
    expect(wolfTransport(wolf("b", '{"transport":"subscription"}'), {})).toBe("subscription");
    expect(wolfTransport(wolf("c", '{"transport":"api"}'), { WOLF_TRANSPORT: "subscription" })).toBe("api");
    expect(wolfTransport(wolf("c2", '{"transport":"subscription"}'), { WOLF_TRANSPORT: "api" })).toBe("subscription");
    expect(wolfTransport(wolf("d"), { WOLF_TRANSPORT: "api" })).toBe("api");
    expect(wolfTransport(wolf("e"), {})).toBe("subscription");
    expect(wolfTransport(wolf("f", "{not json"), {})).toBe("subscription");
    expect(wolfTransport(wolf("g", '{"transport":"openrouter"}'), {})).toBe("subscription");
  });
});

describe("apiWolfNames", () => {
  it("lists only the API-key wolves, which are the only ones a saved Anthropic key restarts", () => {
    const wolves = [wolf("bridge", '{"transport":"subscription"}'), wolf("metered", '{"transport":"api"}'), wolf("unknown")];
    expect(apiWolfNames(wolves, {})).toEqual(["metered"]);
  });
});
