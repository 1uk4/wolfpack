/**
 * tree-rules — the shared, pure rules that decide the shape of a section tree.
 * No I/O, no Math.random: every function is deterministic for its inputs. The
 * rebuild uses them now; incremental repair (leaf + ancestors) reuses them later.
 *
 * Vectors are plain number[]; callers pass raw embeddings. chooseSplit centres
 * them (removing the section's shared direction) before clustering, because
 * entries already placed in one section are all similar in raw cosine.
 */
import { createHash } from "node:crypto";
import { SECTION_TREE } from "@wolfpack/engine";

export type Vec = number[];
export type TreeRules = {
  [K in keyof typeof SECTION_TREE.rules]: number;
};
export const DEFAULT_RULES: TreeRules = { ...SECTION_TREE.rules };

// ── seeded randomness ────────────────────────────────────────────────────────

/** mulberry32: a small seeded PRNG returning floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable 32-bit seed from strings (e.g. sorted member ids). */
export function hashSeed(...parts: Array<string | number>): number {
  const h = createHash("sha256").update(parts.join("\u0000")).digest();
  return h.readUInt32BE(0);
}

function shuffle<T>(a: T[], rand: () => number): T[] {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

// ── vector helpers ───────────────────────────────────────────────────────────

const dot = (a: Vec, b: Vec) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
const norm = (a: Vec) => Math.sqrt(dot(a, a));
export function unit(a: Vec): Vec {
  const n = norm(a);
  return n === 0 ? a.slice() : a.map((x) => x / n);
}
export function cosine(a: Vec, b: Vec): number {
  const na = norm(a), nb = norm(b);
  return na === 0 || nb === 0 ? 0 : dot(a, b) / (na * nb);
}
export function meanVec(vs: Vec[]): Vec {
  const m = new Array<number>(vs[0]?.length ?? 0).fill(0);
  for (const v of vs) for (let i = 0; i < m.length; i++) m[i] += v[i];
  return m.map((x) => x / Math.max(1, vs.length));
}

/** Subtract the mean, then unit-normalise each vector. */
export function centre(vectors: Vec[]): Vec[] {
  if (vectors.length === 0) return [];
  const m = meanVec(vectors);
  return vectors.map((v) => unit(v.map((x, i) => x - m[i])));
}

// ── k-means++ ────────────────────────────────────────────────────────────────

export interface KMeansResult { labels: number[]; inertia: number }

function sqDist(a: Vec, b: Vec): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return s;
}

function kmeansOnce(X: Vec[], k: number, rand: () => number, maxIter = 100): KMeansResult {
  const n = X.length;
  const cents: Vec[] = [X[Math.floor(rand() * n)].slice()];
  while (cents.length < k) {
    const d = X.map((x) => Math.min(...cents.map((c) => sqDist(x, c))));
    const total = d.reduce((a, b) => a + b, 0);
    if (total === 0) { cents.push(X[Math.floor(rand() * n)].slice()); continue; }
    let r = rand() * total, idx = 0;
    for (; idx < n - 1; idx++) { r -= d[idx]; if (r <= 0) break; }
    cents.push(X[idx].slice());
  }
  let labels = new Array<number>(n).fill(0);
  for (let it = 0; it < maxIter; it++) {
    let changed = false;
    labels = X.map((x, i) => {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) { const dd = sqDist(x, cents[c]); if (dd < bd) { bd = dd; best = c; } }
      if (best !== labels[i]) changed = true;
      return best;
    });
    for (let c = 0; c < k; c++) {
      const members = X.filter((_, i) => labels[i] === c);
      if (members.length) cents[c] = meanVec(members);
    }
    if (!changed && it > 0) break;
  }
  const inertia = X.reduce((s, x, i) => s + sqDist(x, cents[labels[i]]), 0);
  return { labels, inertia };
}

/** k-means with k-means++ seeding, best of nInit restarts. Labels are canonical
 *  (renumbered by first appearance) so equal partitions compare equal. */
export function kmeansPP(X: Vec[], k: number, seed: number, nInit = DEFAULT_RULES.nInit): KMeansResult {
  const rand = rng(seed);
  let best: KMeansResult | null = null;
  for (let r = 0; r < nInit; r++) {
    const res = kmeansOnce(X, k, rand);
    if (!best || res.inertia < best.inertia - 1e-12) best = res;
  }
  return { labels: canonical(best!.labels), inertia: best!.inertia };
}

export function canonical(labels: number[]): number[] {
  const map = new Map<number, number>();
  return labels.map((l) => { if (!map.has(l)) map.set(l, map.size); return map.get(l)!; });
}

// ── quality measures ─────────────────────────────────────────────────────────

/** Per-point cosine silhouette (on unit vectors; distance = 1 - cos). */
export function silhouettes(X: Vec[], labels: number[]): number[] {
  const n = X.length;
  const ks = [...new Set(labels)];
  const D = (i: number, j: number) => 1 - dot(X[i], X[j]) / (norm(X[i]) * norm(X[j]) || 1);
  return X.map((_, i) => {
    const own = labels[i];
    const sizeOwn = labels.filter((l) => l === own).length;
    if (sizeOwn <= 1) return 0;
    let a = 0;
    for (let j = 0; j < n; j++) if (j !== i && labels[j] === own) a += D(i, j);
    a /= sizeOwn - 1;
    let b = Infinity;
    for (const k of ks) {
      if (k === own) continue;
      let s = 0, c = 0;
      for (let j = 0; j < n; j++) if (labels[j] === k) { s += D(i, j); c++; }
      if (c) b = Math.min(b, s / c);
    }
    if (!isFinite(b)) return 0;
    const m = Math.max(a, b);
    return m === 0 ? 0 : (b - a) / m;
  });
}
export const meanSilhouette = (X: Vec[], labels: number[]) => {
  const s = silhouettes(X, labels);
  return s.reduce((a, b) => a + b, 0) / Math.max(1, s.length);
};

/** Adjusted Rand Index between two labelings. */
export function ari(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 2) return 1;
  const tab = new Map<string, number>();
  const ra = new Map<number, number>(), rb = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    tab.set(`${a[i]}|${b[i]}`, (tab.get(`${a[i]}|${b[i]}`) ?? 0) + 1);
    ra.set(a[i], (ra.get(a[i]) ?? 0) + 1);
    rb.set(b[i], (rb.get(b[i]) ?? 0) + 1);
  }
  const c2 = (x: number) => (x * (x - 1)) / 2;
  let sumT = 0, sumA = 0, sumB = 0;
  for (const v of tab.values()) sumT += c2(v);
  for (const v of ra.values()) sumA += c2(v);
  for (const v of rb.values()) sumB += c2(v);
  const expected = (sumA * sumB) / c2(n);
  const max = (sumA + sumB) / 2;
  if (max === expected) return 1;
  return (sumT - expected) / (max - expected);
}

// ── chooseSplit ──────────────────────────────────────────────────────────────

export interface SplitDecision {
  /** Group index per input vector (-1 = leftover: stays in the parent). */
  labels: number[];
  k: number;
  silhouette: number;
  /** Fraction of null replicates scoring at least as well. */
  p: number;
  /** Mean pairwise ARI across seeds/bootstraps. */
  stability: number;
  leftovers: number[];
}
export interface SplitRejected { split: null; reason: string; detail?: Record<string, number> }

/** Candidate ks: 2..kMax, widened with n so big sections can split finer. */
export function maxKFor(n: number, rules: TreeRules): number {
  return Math.min(Math.max(rules.kMax, Math.ceil(n / rules.softMax)), Math.floor(n / rules.minGroup));
}

interface Fit { k: number; labels: number[]; sil: number }

function bestFit(Xc: Vec[], seed: number, rules: TreeRules, nInit: number): Fit | null {
  let best: Fit | null = null;
  const kMax = maxKFor(Xc.length, rules);
  for (let k = rules.kMin; k <= kMax; k++) {
    if (k >= Xc.length) break;
    const { labels } = kmeansPP(Xc, k, seed + k, nInit);
    if (new Set(labels).size < 2) continue;
    const sil = meanSilhouette(Xc, labels);
    if (!best || sil > best.sil + 1e-9) best = { k, labels, sil };
  }
  return best;
}

/**
 * Decide whether (and how) to split a section's members. Deterministic.
 * Gates: size above splitAbove; centred best-silhouette beats a permutation
 * null (p < nullAlpha); the partition is stable across seeds and bootstraps
 * (mean ARI >= minAri); after leftover extraction every group has >= minGroup.
 */
export function chooseSplit(
  vectors: Vec[],
  memberIds: string[],
  rules: TreeRules = DEFAULT_RULES,
  /** Evaluate the evidence even at or below splitAbove (eval/diagnostics only). */
  opts: { ignoreSize?: boolean } = {}
): SplitDecision | SplitRejected {
  const n = vectors.length;
  if (n <= rules.splitAbove && !opts.ignoreSize) return { split: null, reason: "below-threshold" };
  const base = hashSeed(rules.seed, ...[...memberIds].sort());
  const Xc = centre(vectors);
  const fit = bestFit(Xc, base, rules, rules.nInit);
  if (!fit) return { split: null, reason: "no-clustering" };

  // Null: independently permute each centred dimension (keeps marginals, kills structure).
  const rand = rng(base ^ 0x9e3779b9);
  const raw = centre(vectors).map((v) => v.slice());
  const dims = raw[0].length;
  let ge = 0;
  const reps = rules.nullReplicates;
  for (let r = 0; r < reps; r++) {
    const P: Vec[] = raw.map(() => new Array<number>(dims));
    for (let j = 0; j < dims; j++) {
      const col = shuffle(raw.map((v) => v[j]), rand);
      for (let i = 0; i < n; i++) P[i][j] = col[i];
    }
    const nf = bestFit(centre(P), base + 1000 + r, rules, 3);
    if (nf && nf.sil >= fit.sil) ge++;
  }
  const p = (ge + 1) / (reps + 1);
  if (p >= rules.nullAlpha) return { split: null, reason: "null-gate", detail: { p, silhouette: fit.sil } };

  // Stability: re-cluster with other seeds and on bootstrap resamples (labels
  // for out-of-sample points = nearest centroid of the resample's clustering).
  const aris: number[] = [];
  for (let r = 0; r < rules.stabilityRuns; r++) {
    const rr = rng(base + 77 + r);
    let labs: number[];
    if (r % 2 === 0) {
      labs = kmeansPP(Xc, fit.k, base + 5000 + r, rules.nInit).labels;
    } else {
      const idx = Xc.map(() => Math.floor(rr() * n));
      const sample = idx.map((i) => Xc[i]);
      const { labels: sl } = kmeansPP(sample, fit.k, base + 6000 + r, rules.nInit);
      const cents: Vec[] = [];
      for (let c = 0; c < fit.k; c++) {
        const m = sample.filter((_, i) => sl[i] === c);
        cents.push(m.length ? meanVec(m) : new Array(dims).fill(0));
      }
      labs = Xc.map((x) => {
        let b = 0, bd = Infinity;
        cents.forEach((c, ci) => { const d = sqDist(x, c); if (d < bd) { bd = d; b = ci; } });
        return b;
      });
    }
    aris.push(ari(fit.labels, labs));
  }
  const stability = aris.reduce((a, b) => a + b, 0) / aris.length;
  if (stability < rules.minAri) return { split: null, reason: "unstable", detail: { stability, p } };

  // Leftovers, then drop groups that fell below minGroup (their members become leftovers too).
  let labels = extractLeftovers(Xc, fit.labels, rules);
  for (;;) {
    const counts = new Map<number, number>();
    for (const l of labels) if (l >= 0) counts.set(l, (counts.get(l) ?? 0) + 1);
    const small = [...counts].filter(([, c]) => c < rules.minGroup).map(([l]) => l);
    if (!small.length) break;
    labels = labels.map((l) => (small.includes(l) ? -1 : l));
  }
  const groups = new Set(labels.filter((l) => l >= 0));
  if (groups.size < 2) return { split: null, reason: "too-few-groups", detail: { p } };
  // Renumber groups by first appearance.
  const map = new Map<number, number>();
  labels = labels.map((l) => {
    if (l < 0) return -1;
    if (!map.has(l)) map.set(l, map.size);
    return map.get(l)!;
  });
  return {
    labels,
    k: groups.size,
    silhouette: fit.sil,
    p,
    stability,
    leftovers: labels.flatMap((l, i) => (l < 0 ? [i] : [])),
  };
}

export const isSplit = (d: SplitDecision | SplitRejected): d is SplitDecision => !("split" in d);

/** Mark entries that fit no group: negative silhouette or alone in their group. -1 = leftover. */
export function extractLeftovers(X: Vec[], labels: number[], rules: TreeRules = DEFAULT_RULES): number[] {
  const sil = silhouettes(X, labels);
  const sizes = new Map<number, number>();
  for (const l of labels) sizes.set(l, (sizes.get(l) ?? 0) + 1);
  return labels.map((l, i) => (sil[i] < rules.leftoverSilhouette || (sizes.get(l) ?? 0) <= 1 ? -1 : l));
}

// ── misplacement ─────────────────────────────────────────────────────────────

export interface Misplaced { index: number; from: string; to: string; own: number; better: number }

/**
 * Entries closer to another section's centroid than to their own (leave-one-out
 * own centroid) by more than the margin. `sections` maps id → member vectors.
 * Sections with fewer than 2 members are not targets. Deterministic order.
 */
export function findMisplaced(
  items: Array<{ id: string; vec: Vec; section: string }>,
  rules: TreeRules = DEFAULT_RULES
): Array<{ id: string; from: string; to: string; own: number; better: number }> {
  const bySec = new Map<string, Array<{ id: string; vec: Vec }>>();
  for (const it of items) {
    if (!bySec.has(it.section)) bySec.set(it.section, []);
    bySec.get(it.section)!.push(it);
  }
  const cents = new Map<string, Vec>();
  for (const [s, m] of bySec) if (m.length >= 2) cents.set(s, unit(meanVec(m.map((x) => x.vec))));
  const out: Array<{ id: string; from: string; to: string; own: number; better: number }> = [];
  for (const it of items) {
    const members = bySec.get(it.section)!;
    if (members.length < 3) continue;
    const rest = members.filter((m) => m.id !== it.id).map((m) => m.vec);
    const own = cosine(unit(meanVec(rest)), it.vec);
    let to = "", better = -Infinity;
    for (const [s, c] of [...cents].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (s === it.section) continue;
      const sc = cosine(c, it.vec);
      if (sc > better) { better = sc; to = s; }
    }
    if (to && better > own + rules.misplacedMargin) out.push({ id: it.id, from: it.section, to, own, better });
  }
  return out;
}

// ── ids and labels ───────────────────────────────────────────────────────────

/** Deterministic child section id: hash of the domain and sorted member entry ids. */
export function hashSectionId(domain: string, memberIds: string[]): string {
  const h = createHash("sha256").update(domain + "\u0000" + [...memberIds].sort().join("\u0000")).digest("base64");
  return "sec-" + domain + "-" + h.replace(/[^A-Za-z0-9]/g, "").slice(0, 6);
}

const STOP = new Set(["and", "the", "of", "a", "an", "for", "to", "in", "on", "with", "&"]);
const tokens = (s: string) =>
  new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !STOP.has(t)).map((t) => t.replace(/s$/, "")));

/** True when a child label just restates its parent (equal, contained, or near-identical token sets). */
export function restatesParent(child: string, parent: string, rules: TreeRules = DEFAULT_RULES): boolean {
  const c = tokens(child), p = tokens(parent);
  if (c.size === 0) return true;
  if (p.size === 0) return false;
  const inter = [...c].filter((t) => p.has(t)).length;
  const union = new Set([...c, ...p]).size;
  if (inter === c.size) return true; // every child word already in the parent name
  return inter / union >= rules.restateJaccard;
}
