import { memoryApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** Graduation: status of the feature on this wolf. */
export async function GET(_req: Request, ctx: { params: Promise<{ name: string; id: string }> }): Promise<Response> {
	const { name, id } = await ctx.params;
	return memoryApi().graduateStatus(name, id);
}
