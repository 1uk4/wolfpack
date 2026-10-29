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

    describe.runIf(options.auth !== false)("auth", () => {
      it("a missing or wrong key is 401 unauthorized", async () => {
        const path = `${buildPath("hubListWork")}?domain=${options.domain}`;
        await expectError(await call(path, {}), "unauthorized");
        await expectError(await call(path, { "X-API-Key": "wrong" }), "unauthorized");
      });
    });
  });
}
