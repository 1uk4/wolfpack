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
import type { LinkWolf } from "@wolfpack/protocol";
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
  /** Item ids `wolf` currently holds (sync read of the work state); used to refuse deleting a wolf that still holds claims. */
  heldBy?: (wolf: string) => string[];
  /** Log sink (seed applied, domains.yaml regeneration failures). Default console. */
  log?: (m: string) => void;
  /** @internal TEST-ONLY seam: replaces the atomic domains.yaml write (failure injection). */
  writeDomainsYaml?: (file: string, text: string) => void;
}

/** Mirrors the CLI's `assertValidDomainName` (packages/cli/src/domains.ts): hubd does not depend on the cli package. */
const RESERVED_DOMAINS = new Set(["_unclassified", "entries", "registry", "domains"]);
export function assertValidDomainName(name: string): void {
  if (!DOMAIN_NAME.test(name)) throw bad(`invalid domain name "${name}" (lower-case letters, digits, hyphens, 2-40 chars, no leading/trailing hyphen)`);
  if (RESERVED_DOMAINS.has(name)) throw bad(`"${name}" is a reserved name and cannot be a domain`);
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
      assertValidDomainName(name);
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
  for (const w of reg.wolves) {
    for (const d of w.domains) {
      if (!reg.domains.some((x) => x.name === d)) throw bad(`seed wolf "${w.name}" subscribes to domain "${d}", which is not in the seeded domains`);
    }
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
  isRetired(name: string): boolean;
  retire(name: string): Promise<{ wolf: unknown; released: string[] }>;
  /**
   * Worker link: a hello from `hostId`. Only wolves the operator pre-registered are accepted, and only when they are unowned or already
   * on this host. Domains are the registry's: reported domains are only compared (domainMismatch), never written. Returns the retired names (never resurrected) and the rejected ones (unknown, or owned by another host).
   */
  applyHello(hostId: string, wolves: LinkWolf[]): Promise<{ retired: string[]; rejected: string[]; domainMismatch: { wolf: string; reported: string[]; granted: string[] }[] }>;
  /** Worker link: a wolf appeared on `hostId`. */
  addWolf(hostId: string, wolf: LinkWolf): Promise<"ok" | "retired" | "rejected">;
  /** Worker link: a wolf left `hostId`: its host is cleared, the entry is kept. */
  removeWolf(hostId: string, name: string): Promise<void>;
  /** Called after every registry change that reached memory (grants may have moved). Returns an unsubscribe. */
  onChange(l: () => void): () => void;
  /** Resolves when queued writes are done. */
  idle(): Promise<void>;
}

export function createRegistry(opts: RegistryOptions): Registry {
  const file = registryFile(opts.dataDir);
  const log = opts.log ?? ((m: string) => console.log(m));
  const writeYaml = opts.writeDomainsYaml ?? atomicWrite;
  const yamlFile = domainsYamlFile(opts.dataDir);
  let reg: RegistryFile;
  if (existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`hubd: registry file ${file} is not valid JSON: ${(e as Error).message}`);
    }
    const p = RegistryFileSchema.safeParse(parsed);
    if (!p.success) throw new Error(`hubd: registry file ${file} is invalid: ${p.error.issues[0]?.path.join(".")}: ${p.error.issues[0]?.message}`);
    reg = p.data;
  } else if (opts.seed && (opts.seed.domainsYaml || opts.seed.wolfYamls?.length)) {
    reg = buildSeed(opts.seed);
    atomicWrite(file, JSON.stringify(reg, null, 2) + "\n");
    log(`hubd: registry seeded (${reg.domains.length} domains, ${reg.wolves.length} wolves) into ${file}`);
  } else reg = empty();
  // registry.json is the source of truth; domains.yaml is derived. Regenerate it at every startup so a crash between the two
  // renames, or a lost or hand-edited domains.yaml, is repaired. Skipped for a brand-new empty registry (no file yet).
  if (existsSync(file)) writeYaml(yamlFile, renderDomainsYaml(reg));

  /** Persist registry.json (the commit point). The caller flips in-memory state right after; domains.yaml is derived and best effort. */
  function persist(next: RegistryFile): void {
    atomicWrite(file, JSON.stringify(next, null, 2) + "\n");
  }
  function regenYaml(next: RegistryFile): void {
    try {
      writeYaml(yamlFile, renderDomainsYaml(next));
    } catch (e) {
      log(`hubd: domains.yaml regeneration failed (will retry on the next registry write or at startup): ${(e as Error).message}`);
    }
  }

  const changeListeners = new Set<() => void>();
  // One queue for every registry write; a failed write does not poison the next.
  let tail: Promise<unknown> = Promise.resolve();
  function mutate<T>(fn: (draft: RegistryFile) => T, skipIfUnchanged = false): Promise<T> {
    const run = tail.then(() => {
      const draft = structuredClone(reg);
      const out = fn(draft);
      resync(draft);
      if (skipIfUnchanged && JSON.stringify(draft) === JSON.stringify(reg)) return out; // nothing changed: no write
      persist(draft); // if this throws, memory is untouched and still equals disk
      reg = draft; // disk now has the new state: memory must follow it immediately
      regenYaml(draft);
      for (const l of [...changeListeners]) {
        try {
          l();
        } catch {
          /* a listener never breaks a registry write */
        }
      }
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

  const q = (v: unknown) => JSON.stringify(String(v).slice(0, 64)); // log-safe: escapes control characters, bounded
  /** Register one wolf from a worker link into `d`. */
  function upsertLinkWolf(d: RegistryFile, hostId: string, w: LinkWolf, mismatches?: { wolf: string; reported: string[]; granted: string[] }[]): "ok" | "retired" | "rejected" {
    const existing = d.wolves.find((x) => x.name === w.name);
    if (!existing) {
      log(`hubd: link ${hostId}: wolf ${q(w.name)} is not registered; refused (an operator must create it first)`);
      return "rejected";
    }
    if (existing.status === "retired") return "retired"; // never resurrect
    if (existing.host !== undefined && existing.host !== hostId) {
      // Whatever the other host's presence (laptops sleep): moving a wolf is an operator action.
      log(`hubd: link ${hostId}: wolf ${q(w.name)} belongs to host ${q(existing.host)}; refused`);
      return "rejected";
    }
    existing.host = hostId; // operator fields (domains, tiers, workspace, tools, status) are never written by the worker
    const reported = [...new Set(w.domains)].sort();
    const granted = [...new Set(existing.domains)].sort();
    if (JSON.stringify(reported) !== JSON.stringify(granted)) {
      log(`hubd: link ${hostId}: wolf ${q(w.name)} reports domains [${reported.map(q).join(", ")}] but the registry grants [${granted.map(q).join(", ")}]; registry wins`);
      mismatches?.push({ wolf: w.name, reported, granted });
    }
    return "ok";
  }
  const ensureHost = (d: RegistryFile, hostId: string) => {
    if (!d.hosts.some((h) => h.name === hostId)) d.hosts.push({ name: hostId });
  };

  return {
    async applyHello(hostId, wolves) {
      if (!HOST_NAME.test(hostId)) throw bad("invalid host name");
      return mutate((d) => {
        ensureHost(d, hostId);
        const names = new Set(wolves.map((w) => w.name));
        const retired: string[] = [];
        const rejected: string[] = [];
        const domainMismatch: { wolf: string; reported: string[]; granted: string[] }[] = [];
        for (const w of wolves) {
          const r = upsertLinkWolf(d, hostId, w, domainMismatch);
          if (r === "retired") retired.push(w.name);
          else if (r === "rejected") rejected.push(w.name);
        }
        // Wolves the hub had on this host but the hello omits: host cleared, entry kept.
        for (const w of d.wolves) if (w.host === hostId && !names.has(w.name)) delete w.host;
        return { retired, rejected, domainMismatch };
      }, true);
    },
    addWolf: (hostId, wolf) =>
      mutate((d) => {
        ensureHost(d, hostId);
        return upsertLinkWolf(d, hostId, wolf);
      }, true),
    removeWolf: (hostId, name) =>
      mutate((d) => {
        const w = d.wolves.find((x) => x.name === name);
        if (w && w.host === hostId) delete w.host;
      }, true),
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
          // A new wolf is always active; a `status` in the body is refused (retire has its own route).
          if (body && typeof body === "object" && "status" in body) throw bad("status cannot be set on create (new wolves are active; use retire)");
          const w = strip(parse(RegistryWolfSchema, body));
          checkWolf(w, d);
          if (d.wolves.some((x) => x.name === w.name)) throw conflict(`wolf ${w.name} exists`);
          d.wolves.push(w); // the entry only: no provisioning
          return w;
        }
        if (c === "domains") {
          const dom = strip(parse(RegistryDomainSchema, body));
          assertValidDomainName(dom.name);
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
        if (c === "wolves") {
          const held = opts.heldBy?.(name) ?? [];
          if (held.length) throw conflict(`wolf ${name} still holds ${held.length} claim(s); retire it first (retire releases them)`);
        }
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
      let released: string[];
      try {
        released = await opts.releaseClaims(name);
      } catch (e) {
        const detail = e instanceof HubError ? e.message : "internal error";
        throw new HubError("engine_error", `wolf ${name} is retired but its claims were not all released (${detail}); retrying retire is safe`);
      }
      return { wolf, released };
    },
    isRetired: (name) => reg.wolves.find((w) => w.name === name)?.status === "retired",
    onChange(l) {
      changeListeners.add(l);
      return () => void changeListeners.delete(l);
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
