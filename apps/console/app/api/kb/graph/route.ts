import { memoryApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** The KB graph; the server picks the source (relay: the hub's own KB copy, token-scoped; local: a KB wolf). */
export async function GET(req: Request): Promise<Response> {
	return memoryApi().kbGraphAuto(new URL(req.url).searchParams);
}
