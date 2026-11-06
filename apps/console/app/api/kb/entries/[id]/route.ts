import { memoryApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** One KB entry; the server picks the source (relay: the hub's KB copy, token-scoped; local: a KB wolf). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await params;
	return memoryApi().kbEntryAuto(id);
}
