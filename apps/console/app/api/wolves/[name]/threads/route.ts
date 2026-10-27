import { threadApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
	const { name } = await ctx.params;
	return threadApi().threads(name);
}

export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
	const { name } = await ctx.params;
	return threadApi().createThread(name, req);
}
