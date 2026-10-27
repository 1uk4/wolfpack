/**
 * The KB graph builder: pure files -> JSON. Ported from the agent dashboard's `buildDomainDataset`, reading
 * `domains.yaml`, each domain's `_digest.json` (section tree), entry frontmatter and work item frontmatter.
 * Never writes. Positions are not computed here.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readDomainRegistry } from "../shared/domain-registry.js";
import { isSafeSegment } from "../shared/safe-path.js";
import { wikilinkTargets } from "../shared/knowledgeLint.js";
import { workIdOfTopic } from "../shared/workLinks.js";
import type { KbRoots } from "../shared/paths.js";
import { readDigestSections, readMarkdownDir, readRelations, str, strList, type DigestSection } from "./read.js";
import { KB_NODE_DEPTH, type KbGraph, type KbGraphDomain, type KbGraphEdge, type KbGraphLayers, type KbGraphNode } from "./types.js";

/** A den topic as the builder needs it (the caller reads the den; kb does not depend on the memory package). */
export interface KbDenTopic {
  id: string;
  title: string;
  summary: string;
  updated: string;
  related: string[];
  promotable: boolean;
}

export interface BuildKbGraphOptions {
  /** Only this domain. Unknown or unsafe: throws `UnknownDomainError`. */
  domain?: string;
  /** Include work items whose stage is `archived`. Default false. */
  archivedWork?: boolean;
  /** Add entry -> entry edges for `[[wikilinks]]` in bodies. Default false. */
  wikilinks?: boolean;
  /** Add den-topic nodes (needs `den`). Default false. */
  denTopics?: boolean;
  /** The den layer's source: one wolf's own topics. */
  den?: { wolf: string; topics: KbDenTopic[] };
  now?: () => Date;
}

export class UnknownDomainError extends Error {
  constructor(readonly domain: string) {
    super(`unknown domain: ${domain}`);
    this.name = "UnknownDomainError";
  }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const COLOR = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|#[0-9a-f]{8}|(rgb|hsl)a?\([0-9.,%\s/-]+\)|[a-z]+)$/i;

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Domain folders present under `<kbBase>/domains/`, sorted. */
export function listDomainDirs(kbBase: string): string[] {
  try {
    return readdirSync(join(kbBase, "domains"), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith(".") && isSafeSegment(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

export function buildKbGraph(roots: Pick<KbRoots, "kbBase">, opts: BuildKbGraphOptions = {}): KbGraph {
  const registry = readDomainRegistry(roots.kbBase);
  const present = listDomainDirs(roots.kbBase);
  const domains: KbGraphDomain[] = [...new Set([...present, ...Object.keys(registry).filter((n) => isSafeSegment(n))])].sort().map((name) => ({
    name,
    label: registry[name]?.label ?? name.charAt(0).toUpperCase() + name.slice(1),
    ...(registry[name]?.color && COLOR.test(registry[name].color!) ? { color: registry[name].color } : {}),
  }));
  if (opts.domain !== undefined && !present.includes(opts.domain)) throw new UnknownDomainError(opts.domain);
  const layers: KbGraphLayers = { archivedWork: opts.archivedWork === true, wikilinks: opts.wikilinks === true, denTopics: opts.denTopics === true };

  const nodes = new Map<string, KbGraphNode>();
  const edges: KbGraphEdge[] = [];
  const addNode = (n: Omit<KbGraphNode, "depth">) => {
    if (!nodes.has(n.id)) nodes.set(n.id, { ...n, depth: KB_NODE_DEPTH[n.kind] });
  };
  const hierarchy = (source: string, target: string) => edges.push({ source, target, kind: "hierarchy" });
  const entryBodies = new Map<string, string>();
  const entryRelations: Array<{ id: string; kind: string; target: string }> = [];
  const workLinks: Array<{ id: string; partOf?: string; dependsOn: string[]; domainNode: string }> = [];

  for (const domain of opts.domain ? [opts.domain] : present) {
    const dir = join(roots.kbBase, "domains", domain);
    const domNode = `dom:${domain}`;
    // a file whose frontmatter does not parse is not an entry
    const entries = readMarkdownDir(join(dir, "entries")).filter((e) => Object.keys(e.meta).length > 0).map((e) => ({ ...e, id: str(e.meta.id) ?? e.file.replace(/\.md$/, "") }));
    const sections = readDigestSections(dir);
    const entryById = new Map(entries.map((e) => [e.id, e]));

    addNode({ id: domNode, kind: "domain", label: domains.find((d) => d.name === domain)!.label, domain });

    const placed = new Set<string>();
    const addEntry = (id: string, sectionId?: string) => {
      const e = entryById.get(id)!;
      addNode({
        id: `ent:${id}`,
        kind: "entry",
        label: cap(str(e.meta.title) ?? id, 60),
        domain,
        ...(sectionId ? { sectionId } : {}),
        ...(str(e.meta.summary) ? { summary: str(e.meta.summary) } : {}),
        ...(str(e.meta.kind) ? { entryKind: str(e.meta.kind) } : {}),
        ...(str(e.meta.maturity) ? { maturity: str(e.meta.maturity) } : {}),
        ...(str(e.meta.authority) ? { authority: str(e.meta.authority) } : {}),
        ...(str(e.meta.currency) ? { currency: str(e.meta.currency) } : {}),
        ...(str(e.meta.updated) ? { updated: str(e.meta.updated) } : {}),
      });
      entryBodies.set(`ent:${id}`, e.body);
      for (const r of readRelations(e.meta)) entryRelations.push({ id: `ent:${id}`, ...r });
    };
    const walk = (list: DigestSection[], parent: string) => {
      for (const s of list) {
        const sid = `sec:${s.sectionId}`;
        if (nodes.has(sid)) continue; // id already taken (another domain, or repeated): keep the first
        addNode({ id: sid, kind: "section", label: cap(s.title, 60), domain, sectionId: s.sectionId, ...(s.summary ? { summary: s.summary } : {}), ...(s.currency ? { currency: s.currency } : {}) });
        hierarchy(parent, sid);
        for (const eid of s.entryIds) {
          if (!entryById.has(eid)) continue; // stale digest: the entry is gone
          if (!placed.has(eid) && nodes.has(`ent:${eid}`)) continue; // owned by another domain: keep the first
          if (!placed.has(eid)) {
            placed.add(eid);
            addEntry(eid, s.sectionId);
          }
          hierarchy(sid, `ent:${eid}`);
        }
        walk(s.children, sid);
      }
    };
    walk(sections, domNode);
    for (const e of entries) {
      if (placed.has(e.id) || nodes.has(`ent:${e.id}`)) continue;
      placed.add(e.id);
      addEntry(e.id);
      hierarchy(domNode, `ent:${e.id}`);
    }

    // Work items
    const items = readMarkdownDir(join(dir, "work")).filter((w) => w.meta.nodeType === "work");
    const live = items
      .map((w) => ({ ...w, id: str(w.meta.id) ?? w.file.replace(/\.md$/, "") }))
      .filter((w) => layers.archivedWork || w.meta.stage !== "archived");
    const ids = new Set(live.map((w) => w.id));
    const parentOf = new Map(live.map((w) => [w.id, str(w.meta.partOf)]));
    const inCycle = (start: string) => {
      const walked = new Set<string>();
      for (let c = parentOf.get(start); c !== undefined && ids.has(c); c = parentOf.get(c)) {
        if (c === start) return true;
        if (walked.has(c)) return false;
        walked.add(c);
      }
      return false;
    };
    for (const w of live) {
      if (nodes.has(`work:${w.id}`)) continue; // owned by another domain: keep the first
      const partOf = inCycle(w.id) ? undefined : str(w.meta.partOf);
      addNode({
        id: `work:${w.id}`,
        kind: "work",
        label: cap(str(w.meta.title) ?? w.id, 60),
        domain,
        workKind: str(w.meta.kind) ?? "task",
        stage: str(w.meta.stage) ?? "plan",
        ...(str(w.meta.assignee) ? { assignee: str(w.meta.assignee) } : {}),
        ...(str(w.meta.updated) ? { updated: str(w.meta.updated) } : {}),
      });
      if (partOf && ids.has(partOf)) {
        hierarchy(`work:${partOf}`, `work:${w.id}`);
        edges.push({ source: `work:${w.id}`, target: `work:${partOf}`, kind: "partOf" });
      } else {
        hierarchy(domNode, `work:${w.id}`);
      }
      workLinks.push({ id: w.id, dependsOn: strList(w.meta.dependsOn), domainNode: domNode });
    }
  }

  if (layers.denTopics && opts.den) {
    const { wolf, topics } = opts.den;
    const denId = (t: string) => `den:${wolf}:${t}`;
    for (const t of [...topics].sort((a, b) => cmp(a.id, b.id))) {
      addNode({ id: denId(t.id), kind: "den-topic", label: cap(t.title || t.id, 60), wolf, ...(t.summary ? { summary: t.summary } : {}), ...(t.updated ? { updated: t.updated } : {}), promotable: t.promotable });
    }
    for (const t of topics) {
      for (const r of t.related) {
        const target = nodes.has(denId(r)) ? denId(r) : `ent:${r}`;
        edges.push({ source: denId(t.id), target, kind: "related", relation: "see_also" });
      }
      const w = workIdOfTopic(t.id);
      if (w) edges.push({ source: denId(t.id), target: `work:${w}`, kind: "related", relation: "work" });
    }
  }

  for (const w of workLinks) for (const dep of w.dependsOn) edges.push({ source: `work:${w.id}`, target: `work:${dep}`, kind: "dependsOn" });
  for (const r of entryRelations) edges.push({ source: r.id, target: `ent:${r.target}`, kind: "related", relation: r.kind });
  if (layers.wikilinks) {
    for (const [id, body] of entryBodies) for (const t of wikilinkTargets(body)) edges.push({ source: id, target: `ent:${t}`, kind: "wikilink" });
  }

  // Never dangle, never duplicate, always the same order.
  const seen = new Set<string>();
  const clean = edges
    .filter((e) => e.source !== e.target && nodes.has(e.source) && nodes.has(e.target))
    .filter((e) => {
      const key = `${e.source}\0${e.target}\0${e.kind}\0${e.relation ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => cmp(a.source, b.source) || cmp(a.target, b.target) || cmp(a.kind, b.kind) || cmp(a.relation ?? "", b.relation ?? ""));

  return {
    nodes: [...nodes.values()].sort((a, b) => a.depth - b.depth || cmp(a.id, b.id)),
    edges: clean,
    layers,
    domain: opts.domain ?? null,
    domains,
    generated: (opts.now?.() ?? new Date()).toISOString(),
  };
}
