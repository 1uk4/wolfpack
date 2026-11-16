import { cachedResponse, memoryApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** Work list cache lifetime: work.changed is not forwarded to the console process, so a short TTL bounds staleness. */
const WORK_TTL_MS = 30_000;

export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
	const { name } = await ctx.params;
	const q = new URL(req.url).searchParams;
	return cachedResponse(req, `work:${name}?${q.toString()}`, () => memoryApi().workList(name, q.get("domain"), q.get("graduated") === "true"), {
		ttlMs: WORK_TTL_MS,
	});
}
