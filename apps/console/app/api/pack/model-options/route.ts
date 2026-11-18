import { packModelOptions } from "@/src/server";

export const dynamic = "force-dynamic";

/** Models the Wolves pickers can offer (src/server/pack/model-options.ts). */
export function GET(): Response {
	return Response.json({ models: packModelOptions() });
}
