import { threadApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
	const { name } = await ctx.params;
	return threadApi().frameFile(name, new URL(req.url).searchParams.get("path"));
}
