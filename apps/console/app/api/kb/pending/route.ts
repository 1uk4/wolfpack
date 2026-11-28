import { memoryApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** The curator's waiting contributions (small list for the graph's Home orbit). Empty when the hub is unreachable. */
export async function GET(): Promise<Response> {
	return memoryApi().kbPending();
}
