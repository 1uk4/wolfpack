/**
 * The thread's SSE stream: client.watch() bridged to the wire, one frame per
 * ThreadEvent (`id:` = the event id). Reconnects resume with Last-Event-ID
 * (or ?from=) — replay of id > from, then live until turn-end, then [DONE].
 */
import { threadApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ name: string; slug: string }> }): Promise<Response> {
	const { name, slug } = await ctx.params;
	return threadApi().stream({ wolf: name, slug }, req);
}
