import { promptsApi } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string; id: string }> };

export async function PUT(req: Request, ctx: Ctx): Promise<Response> {
	const { name, id } = await ctx.params;
	return promptsApi().save(name, id, req);
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
	const { name, id } = await ctx.params;
	return promptsApi().reset(name, id, req);
}
