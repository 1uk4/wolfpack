import { hubPublicUrl } from "@/src/server/pack/hub-public-url";

export const dynamic = "force-dynamic";

/** The hub's public URL for the /pair page's link. Not secret (it is the address a phone opens); read at runtime, never baked into the build. */
export async function GET(): Promise<Response> {
	return Response.json({ url: hubPublicUrl() ?? null }, { headers: { "Cache-Control": "no-store" } });
}
