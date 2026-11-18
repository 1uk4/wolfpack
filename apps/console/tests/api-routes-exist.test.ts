/**
 * Seam: client code vs the app router. Every `/api/...` path a component or core module fetches must be served by a
 * `route.ts` under app/api. A missing route is a Next 404 HTML page, which the callers' `res.json()` turns into a
 * misleading "server is not answering" (work-wolfpack-yGu2smT: /api/pack/machines/keys).
 *
 * The scan takes every string/template literal that starts with `/api/`. Skipped files: tests, fixtures, and the two
 * modules that hold plain prefix lists rather than fetches (src/core/single-mac.ts, src/core/ui/hub-auth.ts).
 * `${...}` inside a template is one path segment; glued to the end of literal text (`graph${q}`) it is a query suffix.
 * Scanned: components, src/core, lib, and app (except app/api). Documented limits: only literals starting with `/api/`
 * are found, and `[...slug]` catch-alls and `(group)` directories are not handled yet.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, it } from "node:test";

const root = join(import.meta.dirname, "..");
const PREFIX_LISTS = new Set(["src/core/single-mac.ts", "src/core/ui/hub-auth.ts"]);
const HOLE = "\u0000";

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

/** Body of the literal that opens at `src[i]` (a quote), with each `${...}` replaced by HOLE. */
function literalBody(src: string, i: number): string {
	const q = src[i];
	let out = "";
	for (let p = i + 1; p < src.length && src[p] !== q; p++) {
		if (q === "`" && src[p] === "$" && src[p + 1] === "{") {
			let depth = 1;
			for (p += 2; p < src.length && depth > 0; p++) depth += src[p] === "{" ? 1 : src[p] === "}" ? -1 : 0;
			p--;
			out += HOLE;
		} else out += src[p];
	}
	return out;
}

/** "/api/a/b${q}" -> ["a", "b"]; "/api/a/${id}" -> ["a", "*"]. Null for a prefix ending in "/". */
function segments(body: string): string[] | null {
	const path = body.split("?")[0]!;
	if (path.endsWith("/")) return null;
	return path.split("/").slice(2).map((s) => (/^\u0000+$/.test(s) ? "*" : s.replaceAll(HOLE, "")));
}

function fetchedPaths(): Map<string, string> {
	const found = new Map<string, string>();
	for (const dir of ["components", "src/core", "lib", "app"]) {
		for (const file of walk(join(root, dir))) {
			const rel = relative(root, file).split(sep).join("/");
			if (rel.startsWith("app/api/")) continue;
			if (!/\.tsx?$/.test(rel) || /\.test\./.test(rel) || /fixtures?/.test(rel) || PREFIX_LISTS.has(rel)) continue;
			const src = readFileSync(file, "utf8");
			for (const m of src.matchAll(/["'`]\/api\//g)) {
				const segs = segments(literalBody(src, m.index));
				if (segs?.length) found.set(`/api/${segs.join("/")}`, rel);
			}
		}
	}
	return found;
}

function routePatterns(): string[][] {
	const api = join(root, "app/api");
	return walk(api)
		.filter((f) => /\/route\.tsx?$/.test(f.split(sep).join("/")))
		.map((f) => relative(api, join(f, "..")).split(sep).filter(Boolean));
}

const matches = (route: string[], segs: string[]) => route.length === segs.length && route.every((r, i) => r.startsWith("[") || r === segs[i]);

describe("client /api fetches", () => {
	it("every fetched /api path is served by an app route", () => {
		const routes = routePatterns();
		const missing = [...fetchedPaths()]
			.filter(([p]) => !routes.some((r) => matches(r, p.split("/").slice(2))))
			.map(([p, file]) => `${p} (fetched in ${file})`);
		assert.deepEqual(missing, []);
	});
});
