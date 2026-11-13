import { keysApi } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Accept a machine's changed key (clears the key-change flag; owner only). */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
	return keysApi().ack(req, (await ctx.params).id);
}
