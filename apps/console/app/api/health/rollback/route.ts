import { healthApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** Owner-initiated rollback of hubd, workerd or console to the kept previous release; needs a verified device bearer. src/server/pack/pack-actions.ts. */
export function POST(req: Request): Promise<Response> {
	return healthApi().rollback(req);
}
