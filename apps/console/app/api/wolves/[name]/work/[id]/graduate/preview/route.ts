import { memoryApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** Graduation step 1: the KB entries the feature would write (nothing is sent). */
export async function POST(_req: Request, ctx: { params: Promise<{ name: string; id: string }> }): Promise<Response> {
	const { name, id } = await ctx.params;
	return memoryApi().graduatePreview(name, id);
}
