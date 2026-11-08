/**
 * GET /api/settings/overview — what the Settings UI needs from the hub and every wolf (hub settings, each wolf's prompts, the compaction
 * prompts), collected with the browser's own device token. One wolf failing yields an `error` on that wolf, not a failed response.
 */
import { settingsOverviewApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
	return settingsOverviewApi().overview();
}
