/**
 * First-run setup, main side (work-wolfpack-UpMwxPl). The wizard page (electron/setup/) talks to these functions over IPC;
 * nothing here imports Electron, so a plain Node test drives it.
 *
 *   needsSetup(stateDir)                 true until setup.json says complete:true (a crash midway leaves it false)
 *   readSetup(stateDir)                  the stored answers { wolf, wolfName, domains, complete } or null
 *   checkKey(key, { baseUrl })           one GET /v1/models with x-api-key -> { ok:true } | { ok:false, error }
 *   runSetup(answers, supervisorOpts)    validate, write credentials.json (0600) and setup.json (complete:false), start the
 *                                        runtime, then mark complete:true; a failed start stops the children and sets the
 *                                        half-made hub aside so a retry can seed again
 *
 * Domain creation: the chosen domains go into hubd's one-time registry seed (supervisor.cjs writes the seed files and passes
 * --seed-domains / --seed-wolf on the first start). No hub token and no second round trip are needed.
 */
const fs = require("node:fs");
const path = require("node:path");
const { createSupervisor, KEY_FILE } = require("./supervisor.cjs");

const ANTHROPIC_BASE = "https://api.anthropic.com";
/** Wolf ids are lower-case letters, digits and hyphens (packages/kb WolfId). */
const WOLF_ID = /^[a-z0-9][a-z0-9-]*$/;
/** Hub domain names for new domains: lower-case letters and digits, 1-32 (the hub's create route; stricter than its seed rule). */
const DOMAIN_NAME = /^[a-z0-9]{1,32}$/;
const RESERVED_DOMAINS = new Set(["entries", "registry", "domains"]);
const MAX_DOMAINS = 12;
const MAX_DESCRIPTION = 140;

const SETUP_FILE = "setup.json"; // { complete, wolf, wolfName, domains:[{name,description}] }: the wizard's answers; later launches read it

/** A stored domain is { name, description } passing the same name, reserved-name and description rules as a typed one; anything else is dropped on read. */
function validStoredDomain(d) {
	return (
		!!d &&
		typeof d.name === "string" &&
		!domainNameProblem(d.name) &&
		(d.description === undefined || (typeof d.description === "string" && d.description.length <= MAX_DESCRIPTION))
	);
}

function readSetup(stateDir) {
	try {
		const v = JSON.parse(fs.readFileSync(path.join(stateDir, SETUP_FILE), "utf8"));
		if (v && typeof v === "object") {
			if (Array.isArray(v.domains)) {
				v.domains = v.domains.filter(validStoredDomain);
				if (!v.domains.some((d) => d.name === "personal")) v.domains.unshift({ name: "personal", description: "" });
			}
			return v;
		}
	} catch {
		/* no record */
	}
	return null;
}

/** The wolf id chosen at setup ("wolf", the pre-wizard default, when there is no record). */
function readWolfId(stateDir) {
	const w = readSetup(stateDir)?.wolf;
	return typeof w === "string" && WOLF_ID.test(w) ? w : "wolf";
}

const needsSetup = (stateDir) => readSetup(stateDir)?.complete !== true;

/** True when credentials.json holds a key (the wizard shows "Key saved"); the key itself never goes to the page. */
function storedKey(stateDir) {
	try {
		const k = JSON.parse(fs.readFileSync(path.join(stateDir, KEY_FILE), "utf8")).ANTHROPIC_API_KEY;
		return typeof k === "string" && k ? k : "";
	} catch {
		return "";
	}
}

/** Temp file in the same folder, then rename: a reader never sees a half-written file. */
function writeAtomic(file, text, mode) {
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
	if (mode) fs.chmodSync(tmp, mode);
	fs.renameSync(tmp, file);
}

/** "Luka's wolf" -> "lukas-wolf". Empty when nothing usable is left. */
function wolfIdFor(displayName) {
	return String(displayName ?? "")
		.toLowerCase()
		.replace(/['’]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
}

/** Plain-language reason a domain name is not allowed, or "" when it is. */
function domainNameProblem(name) {
	if (!DOMAIN_NAME.test(name)) return "Use 1-32 lower-case letters and digits.";
	if (RESERVED_DOMAINS.has(name)) return `"${name}" is reserved.`;
	return "";
}

/**
 * The same rule as anthropicBaseUrlOverride in packages/harness/src/providers/anthropic.ts: https anywhere, or http on loopback only,
 * so the key can never go out in clear text. Copied (5 lines) because that module is TypeScript inside the harness. Anything else -> "".
 */
function vetBaseUrl(raw) {
	let u;
	try {
		u = new URL(String(raw ?? "").trim());
	} catch {
		return "";
	}
	const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
	return u.protocol === "https:" || (u.protocol === "http:" && loopback) ? u.href.replace(/\/+$/, "") : "";
}

/** The Anthropic key check. Never throws. A baseUrl that is not https/loopback is ignored (`fallbackBase` stands in; tests point it at a dead port). */
async function checkKey(key, { baseUrl, fallbackBase = ANTHROPIC_BASE, fetchImpl = fetch } = {}) {
	if (!key || !String(key).trim()) return { ok: false, error: "Paste your API key first." };
	try {
		const res = await fetchImpl(`${vetBaseUrl(baseUrl) || fallbackBase}/v1/models?limit=1`, {
			headers: { "x-api-key": String(key).trim(), "anthropic-version": "2023-06-01" },
			signal: AbortSignal.timeout(15_000),
		});
		if (res.ok) return { ok: true };
		if (res.status === 401 || res.status === 403) return { ok: false, error: "That key didn't work" };
		return { ok: false, error: `Anthropic answered ${res.status}. Try again in a moment.` };
	} catch {
		return { ok: false, error: "Couldn't reach Anthropic" };
	}
}

/** Normalise and validate the wizard's answers (key optional: the stored one is reused). Throws an Error with a plain message. */
function normalizeAnswers(a) {
	const apiKey = String(a?.apiKey ?? "").trim();
	const wolfName = String(a?.wolfName ?? "").trim();
	const wolfId = wolfIdFor(wolfName);
	if (!wolfId || !WOLF_ID.test(wolfId)) throw new Error("Give your wolf a name with at least one letter or digit.");
	const domains = [{ name: "personal", description: "" }]; // always there
	for (const d of Array.isArray(a?.domains) ? a.domains : []) {
		const name = String(d?.name ?? "").trim().toLowerCase();
		const problem = domainNameProblem(name);
		if (problem) throw new Error(`Domain "${name}": ${problem}`);
		const description = String(d?.description ?? "").trim().replace(/\s+/g, " ");
		if (description.length > MAX_DESCRIPTION) throw new Error(`Domain "${name}": keep the description to ${MAX_DESCRIPTION} characters.`);
		const seen = domains.find((x) => x.name === name);
		if (seen) {
			if (name === "personal" && !seen.description) seen.description = description;
			continue;
		}
		domains.push({ name, description });
	}
	if (domains.length > MAX_DOMAINS) throw new Error(`At most ${MAX_DOMAINS} domains.`);
	return { apiKey, wolfId, wolfName, domains };
}

/** Mirrors hubd's assertValidDomainName (packages/hubd/src/registry.ts): the names hubd's seed accepts. */
const HUBD_DOMAIN_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const HUBD_RESERVED = new Set(["_unclassified", "entries", "registry", "domains"]);

/** Strip blanks and one pair of quotes: `"recipes"`, `'recipes'` and `recipes` are one name. */
const unquote = (x) => x.trim().replace(/^(["'])(.*)\1$/, "$2").trim();

/**
 * An existing Wolves/<id> folder is reused (Reset keeps wolves). Read the domains its wolf.yaml already lists (tolerant: a flow list on one
 * or several lines, or a block list; quotes ignored). Returns { domains, rewrite }: `domains` is the file's domains (kept, empty description
 * unless the user chose one) followed by the chosen ones not in it. Both wolf.yaml and hubd's seed get that list, because hubd refuses a
 * seed that lacks a domain the wolf lists. `rewrite` is the wolf.yaml text with the list when the file's `domains:` is the app's one-line
 * flow list, else null (file left alone). Throws a plain message when the file exists but its domains cannot be read. No file -> the
 * chosen domains. Text edit, not the `yaml` package: the desktop shell ships no node_modules (electron-builder.yml keeps only electron/*.cjs).
 */
function mergeWolfDomains(wolfYamlPath, domains) {
	let text;
	try {
		text = fs.readFileSync(wolfYamlPath, "utf8");
	} catch {
		return { domains, rewrite: null }; // no folder yet: the supervisor writes a fresh wolf.yaml with the chosen domains
	}
	let have = null;
	let oneLine = null;
	const flow = /^domains:[ \t]*\[([^\]]*)\][ \t]*(?:#.*)?$/m.exec(text);
	if (flow) {
		have = flow[1].split(",").map(unquote).filter(Boolean);
		if (!flow[1].includes("\n")) oneLine = flow[0];
	} else {
		const block = /^domains:[ \t]*(?:#.*)?\n((?:[ \t]*-[^\n]*\n?|[ \t]*#[^\n]*\n?)+)/m.exec(text);
		if (block) have = block[1].split("\n").filter((l) => /^\s*-/.test(l)).map((l) => unquote(l.replace(/^\s*-/, "").replace(/\s+#.*$/, "")));
	}
	if (!have?.length || have.some((n) => !/^[A-Za-z0-9_-]+$/.test(n))) {
		throw new Error(`This wolf's existing ${wolfYamlPath} has a domains list the app can't read. Fix or remove that line and try again.`);
	}
	const bad = have.find((n) => !HUBD_DOMAIN_NAME.test(n) || HUBD_RESERVED.has(n));
	if (bad) throw new Error(`This wolf's existing ${wolfYamlPath} lists the domain "${bad}", which the app can't use. Fix or remove that entry and try again.`);
	const kept = [...new Set(have)].map((name) => domains.find((d) => d.name === name) ?? { name, description: "" });
	const added = domains.filter((d) => !have.includes(d.name));
	const final = [...kept, ...added];
	if (added.length && !oneLine) {
		throw new Error(`This wolf's settings file ${wolfYamlPath} has a domains list the app can't update. Edit it to one line like domains: [personal] and try again.`);
	}
	const rewrite = oneLine && added.length ? text.replace(oneLine, `domains: [${final.map((d) => d.name).join(", ")}]`) : null;
	return { domains: final, rewrite };
}

/**
 * After a failed start: when there was no registry before this start, move hub/ (+ seed/, the hub token) aside so the retry seeds again,
 * even if hubd made a registry during the failed start (workerd failed after the seed). A registry that existed before is never moved.
 */
function setAsideHalfMadeHub(stateDir, hadRegistry, log) {
	if (hadRegistry) return;
	const dest = path.join(stateDir, `failed-setup-${Date.now()}`);
	for (const name of ["hub", "seed", "hub-token.json"]) {
		const from = path.join(stateDir, name);
		if (!fs.existsSync(from)) continue;
		fs.mkdirSync(dest, { recursive: true });
		fs.renameSync(from, path.join(dest, name));
	}
	if (fs.existsSync(dest)) log?.(`setup failed before the hub was ready: set its folders aside in ${dest}`);
}

/**
 * Write the credential store and the answers, start the runtime for the chosen wolf, then mark setup complete. Nothing is written or
 * started if validation fails. `opts` is createSupervisor's options minus apiKey / wolfName / domains.
 */
async function runSetup(answers, opts) {
	const { apiKey, wolfId, wolfName, domains: chosen } = normalizeAnswers(answers);
	const wolfYamlPath = path.join(opts.wolvesDir, wolfId, "wolf.yaml");
	const prev = readSetup(opts.stateDir);
	const retry = prev?.complete === false && typeof prev.hubWasFresh === "boolean";
	// Recorded on the first attempt and kept across retries (the wolf folder is recomputed when the id changes).
	const hubWasFresh = retry ? prev.hubWasFresh : !fs.existsSync(path.join(opts.stateDir, "hub", "registry", "registry.json"));
	const folderPreexisted = retry && prev.wolf === wolfId ? prev.folderPreexisted === true : fs.existsSync(path.join(opts.wolvesDir, wolfId));
	let domains = chosen;
	let rewrite = null;
	if (folderPreexisted) ({ domains, rewrite } = mergeWolfDomains(wolfYamlPath, chosen)); // before any write: an unusable wolf.yaml fails setup cleanly
	else if (fs.existsSync(wolfYamlPath)) {
		// Setup made this folder on an earlier attempt: this attempt's domains replace its line.
		rewrite = fs.readFileSync(wolfYamlPath, "utf8").replace(/^domains:.*$/m, `domains: [${chosen.map((d) => d.name).join(", ")}]`);
	}
	const key = apiKey || storedKey(opts.stateDir);
	if (!key) throw new Error("An API key is required.");
	fs.mkdirSync(opts.stateDir, { recursive: true, mode: 0o700 });
	fs.chmodSync(opts.stateDir, 0o700);
	writeAtomic(path.join(opts.stateDir, KEY_FILE), JSON.stringify({ ANTHROPIC_API_KEY: key }), 0o600);
	const record = { wolf: wolfId, wolfName, domains };
	writeAtomic(path.join(opts.stateDir, SETUP_FILE), JSON.stringify({ ...record, complete: false, folderPreexisted, hubWasFresh }));
	if (rewrite) writeAtomic(wolfYamlPath, rewrite);
	if (retry && hubWasFresh) setAsideHalfMadeHub(opts.stateDir, false, opts.log); // nothing completed: the retry seeds exactly its answers
	const sup = createSupervisor({ ...opts, wolfName: wolfId, domains });
	opts.onCreate?.(sup); // the caller can stop it even if it quits while starting
	try {
		await sup.start();
	} catch (err) {
		await sup.stop().catch(() => {}); // start() already kills what it launched; this makes sure of it
		if (!err?.stopped) setAsideHalfMadeHub(opts.stateDir, !hubWasFresh, opts.log);
		throw err;
	}
	writeAtomic(path.join(opts.stateDir, SETUP_FILE), JSON.stringify({ ...record, complete: true }));
	return sup;
}

module.exports = { writeAtomic, needsSetup, readSetup, readWolfId, storedKey, checkKey, runSetup, wolfIdFor, domainNameProblem, ANTHROPIC_BASE, MAX_DESCRIPTION, MAX_DOMAINS };
