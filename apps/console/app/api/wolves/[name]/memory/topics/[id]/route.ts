import { memoryApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ name: string; id: string }> }): Promise<Response> {
	const { name, id } = await ctx.params;
	return memoryApi().memoryTopic(name, id, new URL(req.url).searchParams.get("scope"));
}
