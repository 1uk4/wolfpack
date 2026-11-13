import { describe, expect, expectTypeOf, it } from "vitest";
import { KeyChecker, PROVIDERS, maskKey, normalizeKey, providersByCapability, checkKeyShape, type FetchLike, type ProviderId, type SlotId } from "./providers.js";

const json = (status: number, body: unknown): FetchLike => async () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const status = (code: number, text = "oops"): FetchLike => async () => new Response(text, { status: code });
const ANTH = "sk-ant-api03-" + "a".repeat(40);
const DG = "0123456789abcdef0123456789abcdef01234567";
const check = (f: FetchLike, slot = "anthropic", key = ANTH, extra: { signal?: AbortSignal; timeoutMs?: number } = {}) =>
  new KeyChecker({ fetch: f, timeoutMs: extra.timeoutMs }).check(slot, key, extra.signal ? { signal: extra.signal } : undefined);

describe("provider list", () => {
  it("groups a provider under each of its capabilities; memory is Anthropic-only", () => {
    expect(providersByCapability("chat").map((p) => p.id)).toEqual(["anthropic"]);
    expect(providersByCapability("dictation").map((p) => p.id)).toEqual(["deepgram"]);
    expect(providersByCapability("memory").map((p) => p.id)).toEqual(["anthropic"]);
  });
  it("is plain data: survives a JSON round trip unchanged", () => {
    expect(JSON.parse(JSON.stringify(PROVIDERS))).toEqual(PROVIDERS);
    expect(PROVIDERS[0]).toMatchObject({ id: "anthropic", slots: [{ id: "anthropic", label: "Anthropic" }], keyUrl: "https://console.anthropic.com/settings/keys" });
    expect(PROVIDERS[1]).toMatchObject({ id: "deepgram", slots: [{ id: "deepgram", label: "Deepgram" }] });
  });
  it("derives ProviderId and SlotId from the list", () => {
    expectTypeOf<ProviderId>().toEqualTypeOf<"anthropic" | "deepgram">();
    expectTypeOf<SlotId>().toEqualTypeOf<"anthropic" | "deepgram">();
  });
  it("normalizeKey trims surrounding whitespace only", () => {
    expect(normalizeKey("  a b\n")).toBe("a b");
  });
  it("masks all but the last 4 characters, and shows only dots for short keys", () => {
    expect(maskKey("sk-ant-api03-abcdWXYZ")).toBe("••••WXYZ");
    expect(maskKey("abcdefghijk")).toBe("•••••••••••");
    expect(maskKey("abc")).toBe("•••");
  });
  it("warns on a wrong prefix, character set or length with the provider hint", () => {
    expect(checkKeyShape("anthropic", ANTH)).toEqual({ ok: true });
    expect(checkKeyShape("anthropic", "nope")).toEqual({ ok: false, reason: "Anthropic keys start with sk-ant-" });
    expect(checkKeyShape("deepgram", DG)).toEqual({ ok: true });
    expect(checkKeyShape("deepgram", "short")).toEqual({ ok: false, reason: "Deepgram keys are 32 to 64 letters and digits" });
    expect(checkKeyShape("deepgram", "-".repeat(40))).toEqual({ ok: false, reason: "Deepgram keys are 32 to 64 letters and digits" });
  });
  it("accepts only letters, digits, hyphen and underscore in an Anthropic key (nothing a service env file would interpret)", () => {
    for (const bad of ['"', "'", "\\", "$", "#", ";", "="]) expect(checkKeyShape("anthropic", ANTH.slice(0, 20) + bad + ANTH.slice(20))).toEqual({ ok: false, reason: "Anthropic keys start with sk-ant-" });
    expect(checkKeyShape("anthropic", "sk-ant-api03-ab_cd-" + "x".repeat(30))).toEqual({ ok: true });
  });
  it("trims first, and says so when a key has inner spaces, control characters or non-ASCII", () => {
    const why = "key contains spaces or non-ASCII characters";
    expect(checkKeyShape("anthropic", `  ${ANTH}\n`)).toEqual({ ok: true });
    expect(checkKeyShape("anthropic", ANTH.slice(0, 20) + " " + ANTH.slice(20))).toEqual({ ok: false, reason: why });
    expect(checkKeyShape("anthropic", ANTH + "é")).toEqual({ ok: false, reason: why });
    expect(checkKeyShape("deepgram", DG.slice(0, 10) + "\u0007" + DG.slice(10))).toEqual({ ok: false, reason: why });
  });
});

describe("KeyChecker.check", () => {
  it("accepts a 2xx", async () => {
    expect(await check(json(200, {}))).toEqual({ ok: true });
    expect(await check(json(200, {}), "deepgram", DG)).toEqual({ ok: true });
  });
  it("401 is rejected with the provider's message", async () => {
    expect(await check(json(401, { error: { message: "invalid credentials" } }))).toEqual({ ok: false, kind: "rejected", reason: "invalid credentials" });
    expect(await check(json(401, { err_msg: "bad token" }), "deepgram", DG)).toEqual({ ok: false, kind: "rejected", reason: "bad token" });
  });
  it("a non-JSON 401 falls back to 'rejected (HTTP 401)'", async () => {
    expect(await check(status(401, "<html>"))).toEqual({ ok: false, kind: "rejected", reason: "rejected (HTTP 401)" });
  });
  it("403 is rejected; for Deepgram the reason says the key may lack the grant scope", async () => {
    expect(await check(status(403))).toMatchObject({ ok: false, kind: "rejected" });
    const r = await check(status(403), "deepgram", DG);
    expect(r).toMatchObject({ ok: false, kind: "rejected" });
    expect((r as { reason: string }).reason).toContain("lack permission to create dictation tokens");
  });
  it("429 is a network failure (try again), not a bad key", async () => {
    expect(await check(status(429))).toMatchObject({ ok: false, kind: "network", reason: "provider unavailable (HTTP 429)" });
  });
  it("5xx is a network failure", async () => {
    expect(await check(status(503))).toMatchObject({ ok: false, kind: "network", reason: "provider unavailable (HTTP 503)" });
  });
  it("a thrown fetch error is a network failure", async () => {
    expect(await check(async () => { throw new TypeError("fetch failed"); })).toEqual({ ok: false, kind: "network", reason: "fetch failed" });
  });
  it("any other status is 'unexpected' and names the status", async () => {
    expect(await check(status(404))).toEqual({ ok: false, kind: "unexpected", reason: "unexpected response (HTTP 404)" });
  });
  it("a request that outlives the timeout says it timed out", async () => {
    const hang: FetchLike = (_u, init) => new Promise((_res, rej) => init!.signal!.addEventListener("abort", () => rej(init!.signal!.reason)));
    expect(await check(hang, "anthropic", ANTH, { timeoutMs: 10 })).toEqual({ ok: false, kind: "network", reason: "timed out" });
  });
  it("the caller can cancel a check", async () => {
    const hang: FetchLike = (_u, init) => new Promise((_res, rej) => init!.signal!.addEventListener("abort", () => rej(init!.signal!.reason)));
    const ac = new AbortController();
    const p = check(hang, "anthropic", ANTH, { signal: ac.signal });
    ac.abort();
    expect(await p).toEqual({ ok: false, kind: "network", reason: "cancelled" });
  });
  it("frees the connection by cancelling the response body on success", async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    expect(await check(async () => new Response(body, { status: 200 }))).toEqual({ ok: true });
    expect(cancelled).toBe(true);
  });

  it("anthropic sends the exact request", async () => {
    const seen: unknown[] = [];
    await check(async (url, init) => { seen.push({ url, ...init, signal: undefined }); return new Response("{}"); });
    expect(seen).toEqual([{ url: "https://api.anthropic.com/v1/models?limit=1", method: "GET", headers: { "x-api-key": ANTH, "anthropic-version": "2023-06-01" }, body: undefined, signal: undefined }]);
  });
  it("deepgram sends the exact request: a POST grant with ttl 30", async () => {
    const seen: unknown[] = [];
    await check(async (url, init) => { seen.push({ url, ...init, signal: undefined }); return new Response("{}"); }, "deepgram", DG);
    expect(seen).toEqual([{ url: "https://api.deepgram.com/v1/auth/grant", method: "POST", headers: { Authorization: `Token ${DG}`, "Content-Type": "application/json" }, body: JSON.stringify({ ttl_seconds: 30 }), signal: undefined }]);
  });

  it("trims surrounding whitespace before the call", async () => {
    let sent = "";
    await check(async (_u, init) => { sent = init!.headers!["x-api-key"]!; return new Response("{}"); }, "anthropic", `  ${ANTH}\n`);
    expect(sent).toBe(ANTH);
  });
  it("rejects a wrong-shaped key with the hint and never calls fetch", async () => {
    let calls = 0;
    const f: FetchLike = async () => { calls++; return new Response("{}"); };
    expect(await check(f, "anthropic", "nope")).toEqual({ ok: false, kind: "rejected", reason: "Anthropic keys start with sk-ant-" });
    expect(calls).toBe(0);
  });
  it("gives the same verdict as checkKeyShape for the browser/machine cases", async () => {
    const f: FetchLike = async () => new Response("{}");
    for (const key of [`  ${ANTH}\n`, ANTH.slice(0, 20) + " " + ANTH.slice(20), ANTH + "é", ANTH.slice(0, 10) + "\u0007" + ANTH.slice(10)]) {
      const shape = checkKeyShape("anthropic", key);
      const r = await check(f, "anthropic", key);
      expect(r.ok).toBe(shape.ok);
      if (!shape.ok) expect(r).toEqual({ ok: false, kind: "rejected", reason: shape.reason });
    }
  });
  it("throws on an unknown slot (a programming error) without calling fetch", async () => {
    let calls = 0;
    await expect(check(async () => { calls++; return new Response("{}"); }, "nope", "x")).rejects.toThrow("unknown key slot");
    expect(calls).toBe(0);
  });

  describe("never leaks the key into the result", () => {
    it("thrown error message", async () => {
      const r = await check(async () => { throw new Error(`connect failed for ${ANTH} (${ANTH})`); });
      expect(r).toMatchObject({ ok: false, kind: "network" });
      expect(JSON.stringify(r)).not.toContain(ANTH);
    });
    it("a key straddling the 300-character cut leaves no prefix longer than 4 characters", async () => {
      const r = await check(json(401, { error: { message: "x".repeat(290) + ANTH } }));
      const reason = (r as { reason: string }).reason;
      for (let n = 5; n <= ANTH.length; n++) expect(reason).not.toContain(ANTH.slice(0, n));
    });
    for (const [slot, key] of [["anthropic", ANTH], ["deepgram", DG]] as const) {
      it(`${slot}: provider message that echoes it`, async () => {
        const r = await check(json(401, { error: { message: `bad key ${key}` }, err_msg: `bad key ${key}` }), slot, key);
        expect(r).toMatchObject({ ok: false, kind: "rejected" });
        expect(JSON.stringify(r)).not.toContain(key);
      });
      it(`${slot}: non-string message`, async () => {
        const r = await check(json(401, { error: { message: { detail: key } }, err_msg: [key] }), slot, key);
        expect(r).toMatchObject({ ok: false, kind: "rejected" });
        expect(JSON.stringify(r)).not.toContain(key);
      });
    }
    it("caps a long provider message at about 300 characters", async () => {
      const r = await check(json(401, { error: { message: "x".repeat(5000) } }));
      expect((r as { reason: string }).reason.length).toBeLessThanOrEqual(300);
    });
  });
});
