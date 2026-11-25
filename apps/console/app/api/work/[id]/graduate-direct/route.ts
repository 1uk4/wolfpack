import { approvalsApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** Direct graduation (owner console login only): forwards `{contributions, summary?, via, wolf?}` to the hub's graduate-direct with the caller's own token. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	return approvalsApi().graduateDirect(req, (await ctx.params).id);
}
