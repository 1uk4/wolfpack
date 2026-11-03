import { devicesApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
	const body = (await req.json().catch(() => ({}))) as { label?: unknown };
	return devicesApi().mint(typeof body.label === "string" ? body.label : undefined);
}
