import { threadApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(
	req: Request,
	ctx: { params: Promise<{ name: string; slug: string; callId: string }> },
): Promise<Response> {
	const { name, slug, callId } = await ctx.params;
	return threadApi().answerCard({ wolf: name, slug }, callId, req);
}
