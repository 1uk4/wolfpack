import { keysApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** The Keys grid and the Wolves panel's machine list: every machine with its key slots and key-change flag. */
export async function GET(req: Request): Promise<Response> {
	return keysApi().machines(req);
}
