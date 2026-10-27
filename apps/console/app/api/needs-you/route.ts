/** The cross-wolf needs-you list (pending cards + their threads). Listing also starts the activity bridge. */
import { needsYouApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
	return needsYouApi().list();
}
