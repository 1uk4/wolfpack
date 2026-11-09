import { healthApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** Restart one pack unit {service}; needs a recently verified device bearer, works with the hub down. src/server/health-api.ts. */
export function POST(req: Request): Promise<Response> {
	return healthApi().restart(req);
}
