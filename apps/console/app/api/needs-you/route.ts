/** The needs-you list (pending cards + their threads); `?wolf=` limits it to one wolf. Listing also starts the activity bridge. */
import { needsYouApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
	return needsYouApi().list(new URL(req.url).searchParams.get("wolf") ?? undefined);
}
