import { threadApi } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string; slug: string }> };

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
	const { name, slug } = await ctx.params;
	return threadApi().getSettings({ wolf: name, slug });
}

export async function PUT(req: Request, ctx: Ctx): Promise<Response> {
	const { name, slug } = await ctx.params;
	return threadApi().putSettings({ wolf: name, slug }, req);
}
