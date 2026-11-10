import { healthApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** What an update would change and how the manual update unit's last run ended (src/server/pack-actions.ts createUpdater). */
export function GET(): Promise<Response> {
	return healthApi().updateState();
}

/** Owner-initiated update to the latest stable release (starts wolfpack-auto-update-now.service); needs a verified device bearer. */
export function POST(req: Request): Promise<Response> {
	return healthApi().update(req);
}
