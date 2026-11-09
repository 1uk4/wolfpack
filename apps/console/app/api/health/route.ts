import { healthApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** Pack health snapshot (hubd, workerd units, wolves) probed by the console itself; never calls the hub. src/server/health-api.ts. */
export async function GET(): Promise<Response> {
	return healthApi().get();
}
