import { wolfSettingsApi } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
	return wolfSettingsApi().get((await ctx.params).name);
}

export async function PUT(req: Request, ctx: Ctx): Promise<Response> {
	return wolfSettingsApi().save((await ctx.params).name, req);
}
