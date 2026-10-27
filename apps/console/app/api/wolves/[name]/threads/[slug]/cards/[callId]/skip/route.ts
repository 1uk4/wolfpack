import { threadApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(
	_req: Request,
	ctx: { params: Promise<{ name: string; slug: string; callId: string }> },
): Promise<Response> {
	const { name, slug, callId } = await ctx.params;
	return threadApi().skipCard({ wolf: name, slug }, callId);
}
