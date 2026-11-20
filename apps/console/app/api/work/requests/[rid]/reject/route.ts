import { approvalsApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ rid: string }> }): Promise<Response> {
	return approvalsApi().reject(req, (await ctx.params).rid);
}
