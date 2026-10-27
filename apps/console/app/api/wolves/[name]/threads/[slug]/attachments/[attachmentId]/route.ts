import { threadApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ name: string; slug: string; attachmentId: string }> }): Promise<Response> {
	const { name, slug, attachmentId } = await ctx.params;
	return threadApi().attachment({ wolf: name, slug }, attachmentId);
}
