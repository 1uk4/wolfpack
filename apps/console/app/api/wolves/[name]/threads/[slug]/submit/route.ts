import { threadApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ name: string; slug: string }> }): Promise<Response> {
	const { name, slug } = await ctx.params;
	return threadApi().submit({ wolf: name, slug }, req);
}
