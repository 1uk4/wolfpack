import { attachmentLimit } from "@/src/server/attachment-limit";

export const dynamic = "force-dynamic";

/** The per-file upload budget for this console's mode (relay cap or the local attachment cap), read at runtime. Not secret. */
export async function GET(): Promise<Response> {
	return Response.json(attachmentLimit(), { headers: { "Cache-Control": "no-store" } });
}
