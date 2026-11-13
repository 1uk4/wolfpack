import { memoryApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
	const { name } = await ctx.params;
	// Optional body {ids: string[]}: promote only those topics. No body: every topic.
	let ids: string[] | undefined;
	try {
		const body = (await req.json()) as { ids?: unknown };
		if (Array.isArray(body.ids)) ids = body.ids.filter((x): x is string => typeof x === "string");
	} catch {
		/* no body */
	}
	return memoryApi().promote(name, ids);
}
