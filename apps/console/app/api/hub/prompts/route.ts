import { promptsApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** The hub KB sweep and reorg prompts (hubd GET /v1/settings), read-only, for the wolf Prompts tab. */
export async function GET(): Promise<Response> {
	return promptsApi().hub();
}
