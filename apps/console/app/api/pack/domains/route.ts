import { domainsApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** The hub's domains (owner only; src/server/domains-api.ts). */
export function GET(req: Request): Promise<Response> {
	return domainsApi().list(req);
}

/** Add a domain {name, label?, description?, color?}. */
export function POST(req: Request): Promise<Response> {
	return domainsApi().create(req);
}
