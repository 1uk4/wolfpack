import { memoryApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** Graduation step 2: send the previewed graduation. Body: `{token}`. */
export async function POST(req: Request, ctx: { params: Promise<{ name: string; id: string }> }): Promise<Response> {
	const { name, id } = await ctx.params;
	const body = await req.json().catch(() => null);
	return memoryApi().graduateConfirm(name, id, body);
}
