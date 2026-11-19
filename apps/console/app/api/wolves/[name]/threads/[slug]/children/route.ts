import { threadApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ name: string; slug: string }> }): Promise<Response> {
	const { name, slug } = await ctx.params;
	return threadApi().children({ wolf: name, slug }, { all: new URL(req.url).searchParams.get("all") === "1" });
}
