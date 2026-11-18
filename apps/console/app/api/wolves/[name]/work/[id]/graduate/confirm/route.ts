import { invalidateAfter, memoryApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** Graduation step 2: send the previewed graduation. Body: `{token}`. Graduation changes the work list and the KB, so both caches drop. */
export async function POST(req: Request, ctx: { params: Promise<{ name: string; id: string }> }): Promise<Response> {
	const { name, id } = await ctx.params;
	const body = await req.json().catch(() => null);
	return invalidateAfter(await memoryApi().graduateConfirm(name, id, body), ["work:", "graph"]);
}
