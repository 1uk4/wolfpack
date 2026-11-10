import { threadApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PUT(req: Request, ctx: { params: Promise<{ name: string; slug: string; callId: string; page: string }> }): Promise<Response> {
	const { name, slug, callId, page } = await ctx.params;
	return threadApi().saveCardPage({ wolf: name, slug }, callId, page, req);
}
