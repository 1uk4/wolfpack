/**
 * DEV ONLY (work-wolfpack-I2AysMu): a fake /api/pack/domains so the Domains tab can be checked without a hub.
 * `?packFixture=domains` (works, in memory), `domains-delete-subscribed` (delete is refused naming wolves),
 * `domains-hub-down` (every call: hub not answering), `domains-duplicate` (add is refused as a duplicate). Ignored in production.
 */
export const DOMAIN_FIXTURES = ["domains", "domains-delete-subscribed", "domains-hub-down", "domains-duplicate"] as const;
export type DomainFixture = (typeof DOMAIN_FIXTURES)[number];

export function domainFixtureFromUrl(search: string): DomainFixture | null {
	if (process.env.NODE_ENV === "production") return null;
	const f = new URLSearchParams(search).get("packFixture");
	return (DOMAIN_FIXTURES as readonly string[]).includes(f ?? "") ? (f as DomainFixture) : null;
}

type D = { name: string; label?: string; description?: string; color?: string; created?: string };

export function fixtureDomainsFetch(fixture: DomainFixture): typeof fetch {
	let rows: D[] = [
		{ name: "personal", label: "Personal", description: "Life, health and money.", color: "#3b82f6", created: "2026-08-01" },
		{ name: "wolfpack", label: "Wolfpack", description: "The pack itself: code, design, operations.", color: "#f59e0b", created: "2026-08-01" },
		{ name: "snapjack", label: "Snapjack", description: "The group-first poker app.", color: "#10b981", created: "2026-09-12" },
	];
	const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
	return (async (url: RequestInfo | URL, init?: RequestInit) => {
		await new Promise((r) => setTimeout(r, 250));
		if (fixture === "domains-hub-down") return reply(503, { error: "The hub is not answering, so domains cannot be read or changed right now.", code: "hub_unreachable" });
		const method = init?.method ?? "GET";
		const name = decodeURIComponent(String(url).split("/api/pack/domains/")[1] ?? "");
		const body = init?.body ? (JSON.parse(String(init.body)) as D) : ({} as D);
		if (method === "GET") return reply(200, { domains: rows });
		if (method === "POST") {
			if (fixture === "domains-duplicate" || rows.some((r) => r.name === body.name)) return reply(409, { error: `A domain named ${body.name} already exists.`, code: "conflict" });
			rows = [...rows, { ...body, created: new Date().toISOString().slice(0, 10) }];
			return reply(201, { domain: rows.at(-1) });
		}
		if (method === "PATCH") {
			rows = rows.map((r) => (r.name === name ? { ...r, ...body, name } : r));
			return reply(200, { domain: rows.find((r) => r.name === name) });
		}
		if (fixture === "domains-delete-subscribed") {
			return reply(409, { error: `Can't delete ${name}: these wolves are still subscribed to it: hal, 1uk4. Unsubscribe them in each wolf's settings first.`, code: "subscribed", wolves: ["hal", "1uk4"] });
		}
		rows = rows.filter((r) => r.name !== name);
		return reply(200, { deleted: name });
	}) as typeof fetch;
}
