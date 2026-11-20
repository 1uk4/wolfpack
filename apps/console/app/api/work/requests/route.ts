import { approvalsApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** Pending owner-approval requests (graduate, archive, reassign). */
export async function GET(req: Request): Promise<Response> {
	return approvalsApi().list(req);
}
