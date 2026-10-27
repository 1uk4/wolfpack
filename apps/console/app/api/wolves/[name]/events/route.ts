/** The wolf's MemoryEvent SSE: client.watchMemory bridged to the wire (no resume; reconnect = refetch). */
import { memoryApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
	const { name } = await ctx.params;
	return memoryApi().events(name, req);
}
