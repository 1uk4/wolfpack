import { approvalsApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ rid: string }> }): Promise<Response> {
	return approvalsApi().get(req, (await ctx.params).rid);
}
