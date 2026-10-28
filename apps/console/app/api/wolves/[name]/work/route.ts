import { memoryApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
	const { name } = await ctx.params;
	const q = new URL(req.url).searchParams;
	return memoryApi().workList(name, q.get("domain"), q.get("graduated") === "true");
}
