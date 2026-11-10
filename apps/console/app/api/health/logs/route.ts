import { healthApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** Recent journal lines of one pack unit, redacted; needs a verified device bearer. src/server/health-api.ts, pack-actions.ts. */
export function GET(req: Request): Promise<Response> {
	return healthApi().logs(req);
}
