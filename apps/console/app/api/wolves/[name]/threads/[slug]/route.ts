import { threadApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(
	req: Request,
	ctx: { params: Promise<{ name: string; slug: string }> },
): Promise<Response> {
	const { name, slug } = await ctx.params;
	const url = new URL(req.url);
	const rawLimit = url.searchParams.get("limit");
	const limit = rawLimit !== null && Number.isInteger(Number(rawLimit)) && Number(rawLimit) > 0 ? Number(rawLimit) : undefined;
	const before = url.searchParams.get("before") ?? undefined;
	return threadApi().thread({ wolf: name, slug }, { ...(limit !== undefined ? { limit } : {}), ...(before ? { before } : {}) });
}
