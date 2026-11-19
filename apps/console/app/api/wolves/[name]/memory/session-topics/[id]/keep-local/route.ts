import { memoryApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PUT(req: Request, ctx: { params: Promise<{ name: string; id: string }> }): Promise<Response> {
	const { name, id } = await ctx.params;
	return memoryApi().memoryKeepLocal(name, id, await req.json().catch(() => null));
}
