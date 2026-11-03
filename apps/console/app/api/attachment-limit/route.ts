import { attachmentLimit } from "@/src/server/attachment-limit";
import { nextRequestToken } from "@/src/server/console-client";

export const dynamic = "force-dynamic";

/** The per-file upload budget for this console's mode (relay cap or the local attachment cap), decided like the client factory (the request's token counts). Not secret. */
export async function GET(): Promise<Response> {
	const token = await nextRequestToken().catch(() => null);
	const limit = attachmentLimit(process.env, !!token || !!process.env.WOLFPACK_HUB_TOKEN?.trim());
	return Response.json(limit, { headers: { "Cache-Control": "no-store" } });
}
