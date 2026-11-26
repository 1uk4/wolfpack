import { createReleaseNotes } from "@/src/server";

export const dynamic = "force-dynamic";

const notes = createReleaseNotes();

/** GET /api/release-notes?tag=console/v0.1.27-main.5: the GitHub release body for a component or desktop tag (src/server/pack/release-notes.ts). Public release text only, so not gated like /api/updates. 404 when the tag is invalid or GitHub has no notes. */
export async function GET(req: Request): Promise<Response> {
	const tag = new URL(req.url).searchParams.get("tag") ?? "";
	const found = await notes.get(tag);
	if (!found) return Response.json({ error: "no release notes" }, { status: 404 });
	return Response.json({ body: found.body, url: found.url }, { headers: { "Cache-Control": "private, max-age=3600" } });
}
