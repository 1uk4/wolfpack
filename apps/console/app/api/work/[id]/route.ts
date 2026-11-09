import { memoryApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** Owner work ops through the hub: body `{assignee}` or `{moveTo}` (nothing else). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const body = await req.json().catch(() => null);
	return memoryApi().workOp(id, body);
}
