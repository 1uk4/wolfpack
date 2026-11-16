import { invalidateAfter, memoryApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
	const { name } = await ctx.params;
	// Consolidation rewrites the den topics the graph's den layer shows.
	return invalidateAfter(await memoryApi().consolidate(name), ["graph"]);
}
