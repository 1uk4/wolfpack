/**
 * Work items for the app's wolf (work-wolfpack-ZQDxB3j). The wolf's task tools (task_create, task_bind, task_query, task_done, ...) read
 * WORK_ENDPOINT / WORK_TOKEN from the wolfd process env. The app keeps them in the wolf's own `.env` (mode 0600) and the supervisor hands
 * them to workerd, whose wolfd inherits them (workerd never opens a wolf's .env itself).
 *
 *   ensureWorkAccess({ wolfDir, wolfId, hubUrl, hubToken, mintToken, fetchImpl, log })
 *     1. the default domain, named after the wolf, exists on the app's hubd and the wolf is subscribed to it (registry API);
 *        the wolf's wolf.yaml `domains: [..]` line gets it too, so the wolf and the hub agree
 *     2. a work token: the one already in .env if hubd still accepts it, else a new one from mintToken()
 *     3. `.env` gets WORK_ENDPOINT=<hub>/v1/workapi and WORK_TOKEN=<token>; every other line stays as it is
 *   Idempotent: safe on every start, on a first run and on an upgrade from 0.4.0. Returns { endpoint, token }. The token is never logged.
 */
const fs = require("node:fs");
const path = require("node:path");

const ENV_FILE = ".env";

/** KEY=value lines of a .env text -> value of `key` (last one wins, one pair of quotes dropped), or "". */
function envValue(text, key) {
	let out = "";
	for (const line of text.split("\n")) {
		const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
		if (m && m[1] === key) out = m[2].replace(/^(["'])(.*)\1$/, "$2");
	}
	return out;
}

/** Text with each of `pairs` set: an existing line for the key is replaced in place (duplicates dropped), a new one is appended. Other lines untouched. */
function mergeEnv(text, pairs) {
	let lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
	for (const [key, value] of Object.entries(pairs)) {
		const isKey = (l) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(l);
		const at = lines.findIndex(isKey);
		const line = `${key}=${value}`;
		if (at < 0) lines.push(line);
		else lines = lines.flatMap((l, i) => (i === at ? [line] : isKey(l) ? [] : [l]));
	}
	return `${lines.join("\n")}\n`;
}

function writeEnvAtomic(file, text) {
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, text, { mode: 0o600 });
	fs.chmodSync(tmp, 0o600);
	fs.renameSync(tmp, file);
}

const unq = (x) => x.trim().replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2");

/**
 * Find the wolf.yaml `domains` list. Shapes: flow `domains: [a, b]` (one line or several; what the 0.4.0 setup writes) and block (`- a` per line).
 * -> { names, flow } / { names, block } with the matched text, or null for anything else (no list, or a shape this does not know).
 */
function findDomains(text) {
	const flow = /^domains:[ \t]*\[([^\]]*)\][ \t]*(?:#.*)?$/m.exec(text);
	if (flow) return { names: flow[1].split(",").map(unq).filter(Boolean), flow };
	const block = /^domains:[ \t]*(?:#.*)?\n((?:[ \t]*-[^\n]*\n?)+)/m.exec(text);
	if (block) return { names: block[1].split("\n").filter((l) => /^\s*-/.test(l)).map((l) => unq(l.replace(/^\s*-/, ""))), block };
	return null;
}

/** Does the wolf.yaml in this folder list `name` under domains? */
function wolfYamlLists(file, name) {
	try {
		return !!findDomains(fs.readFileSync(file, "utf8"))?.names.includes(name);
	} catch {
		return false;
	}
}

/** Add `name` to wolf.yaml's domains list (flow or block), every other line untouched, written atomically. False for an unknown shape or no file (left alone). */
function addDomainToWolfYaml(file, name) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return false;
	}
	const f = findDomains(text);
	if (!f || f.names.some((n) => !/^[A-Za-z0-9_-]+$/.test(n))) return false;
	if (f.names.includes(name)) return true;
	let next;
	if (f.flow) next = text.replace(f.flow[0], () => f.flow[0].replace(/\[[^\]]*\]/, `[${[...f.names, name].join(", ")}]`));
	else {
		const last = f.block[1].replace(/\n$/, "").split("\n").pop();
		const indent = /^\s*/.exec(last)[0];
		next = text.replace(f.block[0], () => `${f.block[0].replace(/\n?$/, "\n")}${indent}- ${name}\n`);
	}
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, next, { mode: fs.statSync(file).mode & 0o777 });
	fs.renameSync(tmp, file);
	return true;
}

async function ensureWorkAccess({ wolfDir, wolfId, hubUrl, hubToken, mintToken, fetchImpl = fetch, log = () => {} }) {
	const call = (method, p, body, headers = { authorization: `Bearer ${hubToken}` }) =>
		fetchImpl(`${hubUrl}${p}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });

	// 1. the default domain and the wolf's subscription to it
	const dom = await call("GET", `/v1/registry/domains/${encodeURIComponent(wolfId)}`);
	if (dom.status === 404) {
		const r = await call("POST", "/v1/registry/domains", { name: wolfId, description: `${wolfId}'s own work and notes` });
		if (!r.ok) throw new Error(`could not create the ${wolfId} domain (${r.status})`);
		log(`created the default domain "${wolfId}"`);
	} else if (!dom.ok) throw new Error(`could not read the ${wolfId} domain (${dom.status})`);
	const wolfRes = await call("GET", `/v1/registry/wolves/${encodeURIComponent(wolfId)}`);
	if (wolfRes.ok) {
		const domains = (await wolfRes.json())?.wolf?.domains ?? [];
		if (!domains.includes(wolfId)) {
			const r = await call("PATCH", `/v1/registry/wolves/${encodeURIComponent(wolfId)}`, { domains: [...domains, wolfId] });
			if (!r.ok) throw new Error(`could not subscribe the wolf to ${wolfId} (${r.status})`);
		}
	} else if (wolfRes.status === 404) {
		const r = await call("POST", "/v1/registry/wolves", { name: wolfId, domains: [...new Set(["personal", wolfId])] });
		if (!r.ok) throw new Error(`could not register the wolf (${r.status})`);
	} else throw new Error(`could not read the wolf's registry entry (${wolfRes.status})`);
	if (!addDomainToWolfYaml(path.join(wolfDir, "wolf.yaml"), wolfId)) log(`wolf.yaml's domains list has a shape the app does not know: add ${wolfId} to it by hand`);

	// 2. the token: keep a stored one hubd still accepts
	const envFile = path.join(wolfDir, ENV_FILE);
	let envText = "";
	try {
		envText = fs.readFileSync(envFile, "utf8");
	} catch {}
	const accepted = async (t) => {
		if (!t) return false;
		try {
			return (await call("GET", "/v1/workapi/work?limit=1", undefined, { "x-api-key": t })).ok;
		} catch {
			return false;
		}
	};
	let token = envValue(envText, "WORK_TOKEN");
	if (!(await accepted(token))) {
		if (token) log("the stored work token was refused by hubd: minting a new one");
		token = await mintToken();
	}

	// 3. .env
	const endpoint = `${hubUrl}/v1/workapi`;
	const next = mergeEnv(envText, { WORK_ENDPOINT: endpoint, WORK_TOKEN: token });
	if (next !== envText || (fs.statSync(envFile).mode & 0o777) !== 0o600) writeEnvAtomic(envFile, next);
	return { endpoint, token };
}

module.exports = { ensureWorkAccess, wolfYamlLists, envValue, mergeEnv, addDomainToWolfYaml };
