import { threadApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ name: string; slug: string; diagramId: string }> }): Promise<Response> {
	const { name, slug, diagramId } = await ctx.params;
	return threadApi().diagram({ wolf: name, slug }, diagramId);
}
