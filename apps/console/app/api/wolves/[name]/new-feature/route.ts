import { newFeatureApi } from "@/src/server/new-feature-api";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
	return newFeatureApi().start((await ctx.params).name, req);
}
