import { memoryApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ name: string; workId: string }> }): Promise<Response> {
	const { name, workId } = await ctx.params;
	return memoryApi().memoryNode(name, workId, new URL(req.url).searchParams.get("limit"));
}
