import { threadApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ name: string; slug: string; callId: string; qid: string }> }): Promise<Response> {
	const { name, slug, callId, qid } = await ctx.params;
	return threadApi().bindCardText({ wolf: name, slug }, callId, qid, req);
}
