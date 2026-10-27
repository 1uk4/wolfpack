/**
 * The KB graph served by the librarian wolf: nodes and edges as plain JSON, no positions (the console lays them out).
 * Mirrored by the zod schemas in @wolfpack/protocol (`KbGraphSchema`); a test parses the real builder output through them.
 */

export type KbNodeKind = "domain" | "section" | "entry" | "work" | "den-topic";

/** Hierarchy depth by kind: domain 0, section 1, entry 2, work 3, den topic 4. */
export type KbNodeDepth = 0 | 1 | 2 | 3 | 4;
export const KB_NODE_DEPTH: Record<KbNodeKind, KbNodeDepth> = { domain: 0, section: 1, entry: 2, work: 3, "den-topic": 4 };

export interface KbGraphNode {
  /** `dom:<domain>` | `sec:<sectionId>` | `ent:<entryId>` | `work:<workId>` | `den:<wolf>:<topicId>`. */
  id: string;
  kind: KbNodeKind;
  label: string;
  depth: KbNodeDepth;
  /** Owning domain (absent for den topics without one). */
  domain?: string;
  /** Section: its id as in the digest. Entry: the section it sits in (absent for orphans). */
  sectionId?: string;
  /** Section: digest summary. Entry / den topic: the summary line. */
  summary?: string;
  /** Section and entry: digest / frontmatter `currency`. */
  currency?: string;
  /** Entry: frontmatter `kind` (architecture, decision, ...). */
  entryKind?: string;
  maturity?: string;
  authority?: string;
  /** Work: `kind` frontmatter (task, feature, issue, ...). */
  workKind?: string;
  stage?: string;
  assignee?: string;
  /** Den topic: the wolf whose den it is. */
  wolf?: string;
  /** Den topic: false = private working memory, never emitted to the KB. */
  promotable?: boolean;
  updated?: string;
}

export type KbEdgeKind = "hierarchy" | "partOf" | "dependsOn" | "related" | "wikilink";

export interface KbGraphEdge {
  /** `hierarchy`: parent → child (domain → section/orphan entry/root work, section → subsection/entry). `partOf`: child work → parent work. `dependsOn`: work → the work it depends on. `related`: entry → target as written in its relations. `wikilink`: entry whose body links → linked entry. */
  source: string;
  target: string;
  kind: KbEdgeKind;
  /** `related` only: the relation kind (see_also, refines, part_of, depends_on, ...). */
  relation?: string;
}

export interface KbGraphLayers {
  archivedWork: boolean;
  wikilinks: boolean;
  denTopics: boolean;
}

export interface KbGraphDomain {
  name: string;
  label: string;
  /** From domains.yaml `color`, when the owner set one. */
  color?: string;
}

export interface KbGraph {
  nodes: KbGraphNode[];
  edges: KbGraphEdge[];
  /** The layers as applied. */
  layers: KbGraphLayers;
  /** The domain filter as applied; null = all domains. */
  domain: string | null;
  /** Every declared / present domain (not just the filtered one), so a UI can offer the filter. */
  domains: KbGraphDomain[];
  /** ISO timestamp of the build. */
  generated: string;
}

export interface KbWikilink {
  target: string;
  /** The target resolves to an entry (or work item) in the KB. */
  exists: boolean;
}

export interface KbBacklink {
  id: string;
  title: string;
  /** `wikilink` (body link) or `related` (relation, with its kind in `relation`). */
  via: "wikilink" | "related";
  relation?: string;
}

export interface KbEntryDetail {
  id: string;
  title: string;
  domain: string;
  /** Full frontmatter as parsed. */
  frontmatter: Record<string, unknown>;
  body: string;
  wikilinks: KbWikilink[];
  backlinks: KbBacklink[];
}
