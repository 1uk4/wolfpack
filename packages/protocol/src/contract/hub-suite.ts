import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ACTOR_HEADER, ERROR_HTTP_STATUS, ErrorEnvelopeSchema, ROUTES, buildPath, type ErrorCode } from "../index.js";

export interface HubSuiteOptions {
  /** Headers every request carries (the hub's X-API-Key). */
  headers?: Record<string, string>;
  /** A domain the hub holds seeded work in. */
  domain: string;
  /** A thunk (the fixture is seeded in beforeAll) for a seeded item the record route must answer, with the title and kind it must report. */
  record: () => { id: string; title: string; kind: string };
  /** Run the "no/wrong key is 401" checks (the server enforces auth). Default true. */
  auth?: boolean;
}

/**
 * The hub-scoped /v1 contract (hubd): work reads for now; later tickets extend it (writes, claim, events, ...).
 * Run against a server seeded with the fixture described by `options`.
 */
export function runHubSuite(baseUrl: () => string, options: HubSuiteOptions): void {
  const call = (path: string, headers: Record<string, string> | undefined = options.headers) => fetch(baseUrl() + path, { headers });
  async function expectError(res: Response, code: ErrorCode): Promise<void> {
    expect(res.status).toBe(ERROR_HTTP_STATUS[code]);
    expect(ErrorEnvelopeSchema.parse(await res.json()).code).toBe(code);
  }

  describe("/v1 hub contract", () => {
    describe("work reads", () => {
      it("GET /v1/work?domain= lists the domain's items, matching the schema", async () => {
        const res = await call(`${buildPath("hubListWork")}?domain=${encodeURIComponent(options.domain)}`);
        expect(res.status).toBe(200);
        const body = ROUTES.hubListWork.response.schema.parse(await res.json()) as { items: { id: string; domain: string }[] };
        expect(body.items.length).toBeGreaterThan(0);
        expect(body.items.every((i) => i.domain === options.domain)).toBe(true);
        expect(body.items.map((i) => i.id)).toContain(options.record().id);
      });

      it("another domain lists nothing; the graduated flag is validated", async () => {
        const other = await call(`${buildPath("hubListWork")}?domain=no-such-domain`);
        expect(((await other.json()) as { items: unknown[] }).items).toEqual([]);
        await expectError(await call(`${buildPath("hubListWork")}?domain=${options.domain}&graduated=maybe`), "invalid_request");
      });

      it("a missing domain is invalid_request", async () => {
        await expectError(await call(buildPath("hubListWork")), "invalid_request");
      });

      it("GET /v1/work/:id/record answers the page data", async () => {
        const res = await call(buildPath("hubGetWorkRecord", { id: options.record().id }));
        expect(res.status).toBe(200);
        const rec = ROUTES.hubGetWorkRecord.response.schema.parse(await res.json()) as { id: string; title: string; kind: string };
        expect(rec).toMatchObject(options.record());
      });

      it("an unknown item is not_found, a malformed id invalid_request", async () => {
        await expectError(await call(buildPath("hubGetWorkRecord", { id: "work-nope-zzzzzzz" })), "not_found");
        await expectError(await call(buildPath("hubGetWorkRecord", { id: "../etc" })), "invalid_request");
      });
    });

    describe("contributions", () => {
      const asWolf = (id: string) => ({ ...options.headers, "Content-Type": "application/json", [ACTOR_HEADER]: JSON.stringify({ id, kind: "wolf" }) });
      const post = (body: unknown, headers: Record<string, string>) =>
        fetch(baseUrl() + buildPath("submitContribution"), { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
      const contribution = (from: string) => {
        const body = `Knowledge ${randomBytes(4).toString("hex")}.`;
        return {
          from,
          denTopicId: `suite-${randomBytes(4).toString("hex")}`,
          change: "create",
          contentHash: "sha256:" + createHash("sha256").update(body, "utf-8").digest("hex"),
          prevHash: null,
          domainHint: options.domain,
          summary: "A suite contribution.",
          submitted: "2026-10-01 12:00",
          body,
        };
      };

      it("a valid contribution is accepted (201), and posting it again is an idempotent 200", async () => {
        const c = contribution("suite-wolf");
        const res = await post(c, asWolf("suite-wolf"));
        expect(res.status).toBe(201);
        const ack = ROUTES.submitContribution.response.schema.parse(await res.json()) as { id: string; wolf: string; duplicate: boolean };
        expect(ack).toMatchObject({ wolf: "suite-wolf", duplicate: false });
        expect(ack.id).toMatch(new RegExp(`^${c.denTopicId}-[0-9a-f]{10}\\.md$`));
        const again = await post(c, asWolf("suite-wolf"));
        expect(again.status).toBe(200);
        expect(((await again.json()) as { duplicate: boolean }).duplicate).toBe(true);
      });

      it("a malformed contribution is invalid_request", async () => {
        const { contentHash: _drop, ...noHash } = contribution("suite-wolf");
        await expectError(await post(noHash, asWolf("suite-wolf")), "invalid_request");
        await expectError(await post({ ...contribution("suite-wolf"), change: "rewrite" }, asWolf("suite-wolf")), "invalid_request");
        await expectError(await post("not json", asWolf("suite-wolf")), "invalid_request");
      });

      it("a missing actor is rejected", async () => {
        await expectError(await post(contribution("suite-wolf"), { ...options.headers, "Content-Type": "application/json" }), "invalid_request");
      });

      it("a wolf posting as another wolf is rejected", async () => {
        await expectError(await post(contribution("someone-else"), asWolf("suite-wolf")), "invalid_request");
      });
    });

    describe("work writes", () => {
      const op = { "X-Wolfpack-Actor": JSON.stringify({ id: "1uk4", kind: "operator" }) };
      const wolf = { "X-Wolfpack-Actor": JSON.stringify({ id: "w1", kind: "wolf" }) };
      const send = (method: string, path: string, body?: unknown, actor: Record<string, string> | undefined = op) =>
        fetch(baseUrl() + path, {
          method,
          headers: { "Content-Type": "application/json", ...options.headers, ...actor },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      const create = async (extra: Record<string, unknown> = {}) => {
        const res = await send("POST", buildPath("hubCreateWork"), { kind: "task", domain: options.domain, title: "Suite task", assignee: "1uk4", ...extra });
        expect(res.status).toBe(201);
        return ROUTES.hubCreateWork.response.schema.parse(await res.json()) as { id: string; item: { title: string } };
      };
      const record = async (id: string) => (await (await call(buildPath("hubGetWorkRecord", { id }))).json()) as { stage: string; title: string; plan: string; log?: string[] };

      it("POST /v1/work creates an item that reads back", async () => {
        const c = await create();
        expect(c.item.title).toBe("Suite task");
        expect((await record(c.id)).title).toBe("Suite task");
      });

      it("PATCH stage / note / title change the item", async () => {
        const c = await create({ successCriteria: "done when done" });
        const id = c.id;
        const patch = (body: unknown, actor?: Record<string, string>) => send("PATCH", buildPath("hubPatchWork", { id }), body, actor);
        const st = await patch({ stage: "in_build" });
        expect(st.status).toBe(200);
        ROUTES.hubPatchWork.response.schema.parse(await st.json());
        expect((await patch({ note: "hello from the suite" })).status).toBe(200);
        expect((await patch({ title: "Renamed" }, wolf)).status).toBe(200);
        const rec = await record(id);
        expect(rec.stage).toBe("in_build");
        expect(rec.title).toBe("Renamed");
      });

      it("a placement violation is rejected (invalid_request) and an unadvanceable stage is not_ready", async () => {
        await expectError(await send("POST", buildPath("hubCreateWork"), { kind: "initiative", domain: options.domain, title: "x", assignee: "1uk4", partOf: options.record().id }), "invalid_request");
        const c = await create(); // no success criteria
        await expectError(await send("PATCH", buildPath("hubPatchWork", { id: c.id }), { stage: "in_build" }), "not_ready");
        await expectError(await send("PATCH", buildPath("hubPatchWork", { id: "work-nope-zzzzzzz" }), { note: "x" }), "not_found");
        await expectError(await send("PATCH", buildPath("hubPatchWork", { id: c.id }), {}), "invalid_request");
      });

      it("a missing actor is rejected on every write route", async () => {
        const c = await create();
        await expectError(await send("POST", buildPath("hubCreateWork"), { kind: "task", domain: options.domain, title: "t", assignee: "a" }, {}), "invalid_request");
        await expectError(await send("PATCH", buildPath("hubPatchWork", { id: c.id }), { note: "n" }, {}), "invalid_request");
        await expectError(await send("DELETE", buildPath("hubDeleteWork", { id: c.id }), undefined, {}), "invalid_request");
        await expectError(await send("POST", buildPath("hubGraduateWork", { id: c.id }), undefined, {}), "invalid_request");
      });

      it("a non-operator body or assignee write is rejected", async () => {
        const c = await create();
        await expectError(await send("PATCH", buildPath("hubPatchWork", { id: c.id }), { body: "## Plan\n\nx" }, wolf), "unauthorized");
        await expectError(await send("PATCH", buildPath("hubPatchWork", { id: c.id }), { assignee: "w1" }, wolf), "unauthorized");
        expect((await send("PATCH", buildPath("hubPatchWork", { id: c.id }), { assignee: "w1" })).status).toBe(200);
      });

      it("DELETE removes the item; POST graduate marks it graduated", async () => {
        const c = await create();
        const del = await send("DELETE", buildPath("hubDeleteWork", { id: c.id }));
        expect(del.status).toBe(200);
        expect(ROUTES.hubDeleteWork.response.schema.parse(await del.json())).toEqual({ deleted: [c.id] });
        await expectError(await call(buildPath("hubGetWorkRecord", { id: c.id })), "not_found");
        const g = await create();
        const res = await send("POST", buildPath("hubGraduateWork", { id: g.id }));
        expect(res.status).toBe(200);
        expect(((await res.json()) as { item: { graduated?: string } }).item.graduated).toBeTruthy();
      });
    });

    describe.runIf(options.auth !== false)("auth", () => {
      it("a missing or wrong key is 401 unauthorized", async () => {
        const path = `${buildPath("hubListWork")}?domain=${options.domain}`;
        await expectError(await call(path, {}), "unauthorized");
        await expectError(await call(path, { "X-API-Key": "wrong" }), "unauthorized");
      });
    });
  });
}
