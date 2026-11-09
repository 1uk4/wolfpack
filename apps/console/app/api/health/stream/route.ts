import { healthApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** SSE: the pack health snapshot now and after every probe round. src/server/health-api.ts. */
export function GET(req: Request): Response {
	return healthApi().stream(req.signal);
}
