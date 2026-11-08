import { wolfSettingsApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
	return wolfSettingsApi().restart((await ctx.params).name);
}
