import { memoryApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
	const { name } = await ctx.params;
	return memoryApi().memoryObservations(name, new URL(req.url).searchParams.get("limit"));
}
