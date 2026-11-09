/**
 * Test support: what is wrong with a /healthz body for `service` (empty = the standard shape).
 * Shared by the hubd, workerd and wolfd /healthz tests so each asserts the same contract: `expect(healthShapeProblems(b, "hubd", v)).toEqual([])`.
 */
export function healthShapeProblems(body: unknown, service: string, version: string): string[] {
  if (body === null || typeof body !== "object") return ["body is not an object"];
  const b = body as Record<string, unknown>;
  const out: string[] = [];
  if (b.ok !== true) out.push(`ok is ${JSON.stringify(b.ok)}`);
  if (b.service !== service) out.push(`service is ${JSON.stringify(b.service)}, want ${service}`);
  if (b.version !== version) out.push(`version is ${JSON.stringify(b.version)}, want ${version}`);
  if (typeof b.uptimeS !== "number") out.push("uptimeS is not a number");
  const lag = b.lag as Record<string, unknown> | undefined;
  if (typeof lag?.p99Ms !== "number" || typeof lag?.maxMs !== "number") out.push("lag.p99Ms/maxMs are not numbers");
  return out;
}
