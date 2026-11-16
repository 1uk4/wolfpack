import { threadApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
	const { name } = await ctx.params;
	return threadApi().threads(name, { all: new URL(req.url).searchParams.get("all") === "1" });
}

export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
	const { name } = await ctx.params;
	return threadApi().createThread(name, req);
}
