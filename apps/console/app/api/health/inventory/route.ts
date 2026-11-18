import { healthApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** The hub's pack inventory read with the viewer's own bearer (src/server/pack/health-api.ts inventory). Always 200 with {state}. */
export function GET(req: Request): Promise<Response> {
	return healthApi().inventory(req);
}
