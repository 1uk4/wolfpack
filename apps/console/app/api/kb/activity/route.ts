import { kbActivityApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** The hub curator's KB activity (incoming, decisions, recent changes); query: since, before, limit, domain. */
export async function GET(req: Request): Promise<Response> {
	return kbActivityApi().kbActivity(new URL(req.url).searchParams);
}
