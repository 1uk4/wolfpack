import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { mkdtempSync, existsSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeParentBody } from "./parent-embed.js";

const parent: any = { id: "work-x-P1", domain: "x", kind: "feature", title: "P", log: [] };
const dirs: string[] = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), "pe-")); dirs.push(d); return d; };
const roots = () => { const d = mk(); return { kbBase: d, opsRoot: d, denLocal: d } as any; };
const file = (r: any) => join(r.kbBase, "domains", "x", "work", "work-x-P1.md");
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function stub(status: number, errText = "boom") {
  const seen: any[] = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => { seen.push({ m: req.method, u: req.url, k: req.headers["x-api-key"], b: JSON.parse(b || "{}") }); res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(status < 300 ? { item: parent } : { error: errText })); });
  });
  return new Promise<{ url: string; seen: any[]; close: () => void }>((ok) => srv.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(srv.address() as any).port}`, seen, close: () => srv.close() })));
}

describe("writeParentBody", () => {
  it("sends over HTTP when WORK_ENDPOINT is set and writes nothing locally", async () => {
    const s = await stub(200); const r = roots();
    expect((await writeParentBody(r, parent, "BODY", { env: { WORK_ENDPOINT: s.url, WORK_TOKEN: "t" } })).status).toBe("remote");
    expect(s.seen).toEqual([{ m: "PATCH", u: "/work/work-x-P1", k: "t", b: { body: "BODY" } }]);
    expect(existsSync(file(r))).toBe(false);
    s.close();
  });
  it("on HTTP failure: logs, notifies, spills outside KB_BASE, writes nothing locally, never leaks the token", async () => {
    const token = "SECRET-TOKEN-123";
    const s = await stub(500, `bad key ${token}`); const r = roots(); const den = mk(); const logs: string[] = []; const notes: string[] = [];
    const res = await writeParentBody(r, parent, "BODY", { env: { WORK_ENDPOINT: s.url, WORK_TOKEN: token, WOLF_DEN: den }, log: (m) => logs.push(m), notify: (m) => notes.push(m) });
    expect(res.status).toBe("failed");
    expect(logs[0]).toContain("NOT saved");
    const spill = (res as any).spillPath as string;
    expect(spill.startsWith(join(den, "work-spill", "work-x-P1-"))).toBe(true);
    expect(readFileSync(spill, "utf8")).toBe("BODY");
    expect(logs.join("\n")).toContain(spill);
    expect(notes.length).toBe(1);
    expect(logs.join("\n") + notes.join("\n") + res.status + JSON.stringify(res)).not.toContain(token);
    expect(existsSync(file(r))).toBe(false);
    expect(readdirSync(r.kbBase)).toEqual([]);
    s.close();
  });
  it("warns when WORK_ENDPOINT is set but WORK_TOKEN is missing", async () => {
    const s = await stub(401); const logs: string[] = [];
    await writeParentBody(roots(), parent, "B", { env: { WORK_ENDPOINT: s.url }, log: (m) => logs.push(m), notify: () => {} });
    expect(logs[0]).toContain("WORK_TOKEN is missing");
    s.close();
  });
  it("writes locally when no endpoint is configured", async () => {
    const r = roots();
    expect((await writeParentBody(r, parent, "BODY", { env: {} })).status).toBe("local");
    expect(existsSync(file(r))).toBe(true);
  });
});
