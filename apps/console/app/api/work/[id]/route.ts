import { invalidateAfter, memoryApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** Owner work ops through the hub: body `{assignee}` or `{moveTo}` (nothing else). A success drops the cached work lists. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const body = await req.json().catch(() => null);
	return invalidateAfter(await memoryApi().workOp(id, body), ["work:"]);
}
