import { promptsApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
	return promptsApi().list((await ctx.params).name);
}
