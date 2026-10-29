/**
 * The hub registry: hosts, wolves, domains, subscriptions, in `<dataDir>/registry/registry.json` (see layout.ts).
 *
 * - Seeded ONCE: when the file is absent and explicit seed sources are given (a domains.yaml and/or wolf.yaml v2 files). devices.yaml
 *   is not read. Without seed sources nothing is created until the first write. Seed paths are never defaulted.
 * - Every write goes through one promise queue, persists atomically (tmp + rename), and then regenerates `<kbBase>/domains.yaml`
 *   (atomically too) in the format `wolfpack domain` writes and the existing readers parse.
 * - Subscriptions mirror each wolf's `domains`; writing either side keeps the other in step.
 * - "Create wolf" writes only the entry. "Retire wolf" marks it retired and releases its claims through `releaseClaims`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { WolfFileSchema } from "@wolfpack/engine";
import { WolfIdSchema } from "@wolfpack/kb/client";
import { RegistryFileSchema, RegistrySubscriptionSchema, RegistryHostSchema, RegistryWolfSchema, RegistryDomainSchema, type RegistryFile } from "@wolfpack/protocol";
import { loadWorkState } from "@wolfpack/kb/client";
import type { KbRoots } from "@wolfpack/kb/shared";
import { HubError } from "./errors.js";
import { unclaimItem } from "./work-writes.js";
import { domainsYamlFile, registryFile } from "./layout.js";

export interface RegistrySeed {
  /** A domains.yaml (the `wolfpack domain` registry). */
  domainsYaml?: string;
  /** wolf.yaml v2 files, one per wolf. */
  wolfYamls?: string[];
}

export type Collection = "hosts" | "wolves" | "domains" | "subscriptions";

export interface RegistryOptions {
  dataDir: string;
  seed?: RegistrySeed;
  /** Release every claim held by `wolf` (hub work writer queue); returns the item ids released. */
  releaseClaims: (wolf: string) => Promise<string[]>;
}

const DOMAIN_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const HOST_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/i;

const empty = (): RegistryFile => ({ version: 1, hosts: [], wolves: [], domains: [], subscriptions: [] });
const today = () => new Date().toISOString().slice(0, 10);
const bad = (m: string) => new HubError("invalid_request", m);

function strip<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** Build the one-time seed from explicit files. Throws HubError(invalid_request) on unreadable or invalid input. */
export function buildSeed(seed: RegistrySeed): RegistryFile {
  const reg = empty();
  if (seed.domainsYaml) {
    let doc: { domains?: Record<string, { label?: unknown; description?: unknown; color?: unknown; created?: unknown } | null> };
    try {
      doc = (yamlParse(readFileSync(seed.domainsYaml, "utf8")) ?? {}) as typeof doc;
    } catch (e) {
      throw bad(`seed domains.yaml unreadable: ${(e as Error).message.split("\n")[0]}`);
    }
    for (const [name, v] of Object.entries(doc.domains ?? {})) {
      const str = (x: unknown) => (x === undefined || x === null || x === "" ? undefined : String(x));
      reg.domains.push(strip({ name, label: str(v?.label), description: str(v?.description), color: str(v?.color), created: str(v?.created) }));
    }
  }
  for (const file of seed.wolfYamls ?? []) {
    let raw: unknown;
    try {
      raw = yamlParse(readFileSync(file, "utf8"));
    } catch (e) {
      throw bad(`seed wolf.yaml unreadable: ${(e as Error).message.split("\n")[0]}`);
    }
    const p = WolfFileSchema.safeParse(raw);
    if (!p.success) throw bad(`seed wolf.yaml invalid: ${p.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    const w = p.data;
    if (!WolfIdSchema.safeParse(w.name).success) throw bad(`seed wolf name "${w.name}" is not a valid wolf id`);
    if (reg.wolves.some((x) => x.name === w.name)) throw bad(`seed wolf "${w.name}" appears twice`);
    reg.wolves.push(strip({ name: w.name, domains: w.domains, tools: w.tools, workspace: w.workspace, tiers: w.tiers, status: "active" as const }));
  }
  resync(reg);
  return reg;
}

/** subscriptions = wolves x domains (keeps existing order where possible). */
function resync(reg: RegistryFile): void {
  reg.subscriptions = reg.wolves.flatMap((w) => [...new Set(w.domains)].map((domain) => ({ wolf: w.name, domain })));
}

/** The domains.yaml text: exactly what `wolfpack domain` writes (`yaml.stringify({domains:{name:{label,description,created}}})`), plus `color` when set. */
export function renderDomainsYaml(reg: RegistryFile): string {
  const domains: Record<string, Record<string, string>> = {};
  for (const d of reg.domains) {
    domains[d.name] = strip({ label: d.label, description: d.description, created: d.created, color: d.color }) as Record<string, string>;
  }
  return yamlStringify({ domains });
}

function atomicWrite(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export interface Registry {
  list(c: Collection): unknown[];
  get(c: Collection, name: string): unknown;
  create(c: Collection, body: unknown): Promise<unknown>;
  update(c: Collection, name: string, body: Record<string, unknown>): Promise<unknown>;
  remove(c: Collection, name: string): Promise<string>;
  retire(name: string): Promise<{ wolf: unknown; released: string[] }>;
  /** Resolves when queued writes are done. */
  idle(): Promise<void>;
}

export function createRegistry(opts: RegistryOptions): Registry {
  const file = registryFile(opts.dataDir);
  let reg: RegistryFile;
  if (existsSync(file)) {
    const p = RegistryFileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!p.success) throw new Error(`hubd: registry file is invalid: ${p.error.issues[0]?.message}`);
    reg = p.data;
  } else if (opts.seed && (opts.seed.domainsYaml || opts.seed.wolfYamls?.length)) {
    reg = buildSeed(opts.seed);
    persist(reg);
  } else reg = empty();

  function persist(next: RegistryFile): void {
    atomicWrite(file, JSON.stringify(next, null, 2) + "\n");
    atomicWrite(domainsYamlFile(opts.dataDir), renderDomainsYaml(next));
  }

  // One queue for every registry write; a failed write does not poison the next.
  let tail: Promise<unknown> = Promise.resolve();
  function mutate<T>(fn: (draft: RegistryFile) => T): Promise<T> {
    const run = tail.then(() => {
      const draft = structuredClone(reg);
      const out = fn(draft);
      resync(draft);
      persist(draft);
      reg = draft;
      return out;
    });
    tail = run.catch(() => {});
    return run;
  }

  const items = (c: Collection, r: RegistryFile = reg): { name: string }[] =>
    c === "subscriptions" ? r.subscriptions.map((s) => ({ name: `${s.wolf}:${s.domain}`, ...s })) : (r[c] as { name: string }[]);
  const find = (c: Collection, name: string) => items(c).find((x) => x.name === name);
  const strip2 = (c: Collection, x: unknown) => (c === "subscriptions" ? { wolf: (x as { wolf: string }).wolf, domain: (x as { domain: string }).domain } : x);

  const parse = <T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, v: unknown): T => {
    const r = schema.safeParse(v);
    if (r.success) return r.data;
    throw bad(r.error.issues.map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`).join("; "));
  };
  const checkWolf = (w: { name: string; host?: string; domains: string[] }, d: RegistryFile) => {
    if (!WolfIdSchema.safeParse(w.name).success) throw bad("wolf name is not a valid wolf id (lower-case letters, digits, hyphens)");
    if (w.host !== undefined && !d.hosts.some((h) => h.name === w.host)) throw bad(`unknown host ${w.host}`);
    for (const dom of w.domains) if (!d.domains.some((x) => x.name === dom)) throw bad(`unknown domain ${dom}`);
  };
  const conflict = (m: string) => new HubError("conflict", m);
  const notFound = (c: Collection, n: string) => new HubError("not_found", `${c.replace(/s$/, "")} ${n} not found`);

  return {
    list: (c) => items(c).map((x) => strip2(c, x)),
    get(c, name) {
      const x = find(c, name);
      if (!x) throw notFound(c, name);
      return strip2(c, x);
    },
    create: (c, body) =>
      mutate((d) => {
        if (c === "hosts") {
          const h = parse(RegistryHostSchema, body);
          if (!HOST_NAME.test(h.name)) throw bad("invalid host name");
          if (d.hosts.some((x) => x.name === h.name)) throw conflict(`host ${h.name} exists`);
          d.hosts.push(strip(h));
          return h;
        }
        if (c === "wolves") {
          const w = strip(parse(RegistryWolfSchema, body));
          checkWolf(w, d);
          if (d.wolves.some((x) => x.name === w.name)) throw conflict(`wolf ${w.name} exists`);
          d.wolves.push(w); // the entry only: no provisioning
          return w;
        }
        if (c === "domains") {
          const dom = strip(parse(RegistryDomainSchema, body));
          if (!DOMAIN_NAME.test(dom.name)) throw bad("invalid domain name (lower-case letters, digits, hyphens, 2-40 chars)");
          if (d.domains.some((x) => x.name === dom.name)) throw conflict(`domain ${dom.name} exists`);
          d.domains.push({ ...dom, created: dom.created ?? today() });
          return d.domains.at(-1);
        }
        const s = parse(RegistrySubscriptionSchema, body);
        const w = d.wolves.find((x) => x.name === s.wolf);
        if (!w) throw new HubError("not_found", `wolf ${s.wolf} not found`);
        if (!d.domains.some((x) => x.name === s.domain)) throw bad(`unknown domain ${s.domain}`);
        if (w.domains.includes(s.domain)) throw conflict(`${s.wolf} is already subscribed to ${s.domain}`);
        w.domains.push(s.domain);
        return s;
      }),
    update: (c, name, body) =>
      mutate((d) => {
        if (c === "subscriptions") throw bad("subscriptions cannot be updated; delete and create");
        const list = d[c] as { name: string }[];
        const i = list.findIndex((x) => x.name === name);
        if (i < 0) throw notFound(c, name);
        const schema = c === "hosts" ? RegistryHostSchema : c === "wolves" ? RegistryWolfSchema : RegistryDomainSchema;
        const merged = strip(parse(schema, { ...list[i], ...body, name }));
        if (c === "hosts" && !HOST_NAME.test(name)) throw bad("invalid host name");
        if (c === "wolves") {
          const w = merged as { name: string; host?: string; domains: string[] };
          if (body.host !== undefined && !d.hosts.some((h) => h.name === w.host)) throw bad(`unknown host ${w.host}`);
          for (const dom of body.domains ? w.domains : []) if (!d.domains.some((x) => x.name === dom)) throw bad(`unknown domain ${dom}`);
        }
        list[i] = merged as { name: string };
        return merged;
      }),
    remove: (c, name) =>
      mutate((d) => {
        if (c === "subscriptions") {
          const [wn, dn] = name.split(":");
          const w = d.wolves.find((x) => x.name === wn);
          if (!w || !w.domains.includes(dn ?? "")) throw notFound(c, name);
          w.domains = w.domains.filter((x) => x !== dn);
          return name;
        }
        const list = d[c] as { name: string }[];
        const i = list.findIndex((x) => x.name === name);
        if (i < 0) throw notFound(c, name);
        if (c === "hosts" && d.wolves.some((w) => w.host === name)) throw conflict(`host ${name} still has wolves`);
        if (c === "domains" && d.wolves.some((w) => w.domains.includes(name))) throw conflict(`domain ${name} still has subscribers`);
        list.splice(i, 1);
        return name;
      }),
    async retire(name) {
      const wolf = await mutate((d) => {
        const w = d.wolves.find((x) => x.name === name);
        if (!w) throw notFound("wolves", name);
        w.status = "retired";
        return structuredClone(w);
      });
      // Safe to repeat: a retry after a partial failure releases whatever is still held.
      const released = await opts.releaseClaims(name);
      return { wolf, released };
    },
    idle: () => tail.then(() => {}),
  };
}

/**
 * Release every claim `wolf` holds: one work.unbound per item with boundBy === wolf, via `unclaimItem` (operator actor).
 * Run it INSIDE the hub work writer queue (`writeWork(actor, () => releaseWolfClaims(roots, wolf))`). Returns the item ids.
 */
export function releaseWolfClaims(roots: KbRoots, wolf: string): string[] {
  const held = [...loadWorkState(roots).values()].filter((i) => i.boundBy === wolf).map((i) => i.id as string);
  for (const id of held) unclaimItem(roots, id, { id: "system", kind: "operator" });
  return held;
}
