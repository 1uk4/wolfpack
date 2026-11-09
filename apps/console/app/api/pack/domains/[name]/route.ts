import { domainsApi } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

/** Edit a domain's label, description or colour (owner only; the name cannot change). */
export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
	return domainsApi().update(req, (await ctx.params).name);
}

/** Delete a domain; the hub refuses while wolves are subscribed. KB files are kept. */
export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
	return domainsApi().remove(req, (await ctx.params).name);
}
