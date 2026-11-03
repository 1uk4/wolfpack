import { devicesApi } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
	return devicesApi().list();
}
