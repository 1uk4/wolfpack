import { attachmentLimit } from "@/src/server/thread/attachment-limit";

export const dynamic = "force-dynamic";

/**
 * The per-file upload budget for this console's mode (relay cap or the local attachment cap), read at runtime. Not secret.
 * Decided like the live client (getConsoleClient passes a per-request token resolver, which counts as a token): a hub URL
 * without WOLFPACK_HUB_RELAY=0 and without a direct WOLFPACK_API_URL means relay.
 */
export async function GET(): Promise<Response> {
	return Response.json(attachmentLimit(process.env, true), { headers: { "Cache-Control": "no-store" } });
}
