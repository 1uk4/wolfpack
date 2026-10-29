import { threadApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(
	req: Request,
	ctx: { params: Promise<{ name: string; slug: string }> },
): Promise<Response> {
	const { name, slug } = await ctx.params;
	const url = new URL(req.url);
	const rawLimit = url.searchParams.get("limit");
	const before = url.searchParams.get("before") ?? undefined;
	if (rawLimit !== null && !/^[1-9]\d*$/.test(rawLimit)) {
		return Response.json({ error: "limit must be a positive integer" }, { status: 400 });
	}
	if (before !== undefined && rawLimit === null) {
		return Response.json({ error: "before needs limit" }, { status: 400 });
	}
	const limit = rawLimit !== null ? Number(rawLimit) : undefined;
	return threadApi().thread({ wolf: name, slug }, { ...(limit !== undefined ? { limit } : {}), ...(before ? { before } : {}) });
}
