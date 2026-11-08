import { wolfSettingsApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
	return wolfSettingsApi().reveal((await ctx.params).name, req);
}
