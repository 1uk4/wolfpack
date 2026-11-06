import { devicesApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	return devicesApi().revoke(id, { cascade: new URL(req.url).searchParams.get("cascade") === "1" });
}
