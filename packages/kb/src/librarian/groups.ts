/**
 * Entry groups. An entry may sit under another anchored entry (`group: <key>`,
 * ordered by `groupDate:`), as a standing feature's entry sits under its
 * initiative's. The holder (the entry anchored by the key) lists its members in
 * `## Delivered`; this keeps that list in step with the members on disk,
 * whichever of the two was written first.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, parseFrontmatter } from "@wolfpack/engine";
import { type KbRoots, contentHash, deliveredBullets, entriesDir, setDelivered, type DeliveredBullet } from "../shared/index.js";
import { anchorIndex, groupMembers } from "./anchors.js";
import { snapshotIfChanged } from "./versions.js";

const normTitle = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();

/** An entry's text the way produce hashes it: title, summary and detail (no `## Detail` wrapper, no Context). */
function hashedText(md: string): string {
  const { fields, body } = parseFrontmatter(md);
  const title = String(fields.title ?? "");
  const afterH1 = /^\s*#[ \t]+[^\n]*\n+([\s\S]*)$/.exec(body)?.[1] ?? body;
  const at = afterH1.search(/\n\s*\n/);
  const summary = at < 0 ? afterH1.trim() : afterH1.slice(0, at).trim();
  let detail = at < 0 ? "" : afterH1.slice(at).trim();
  detail = detail.replace(/^## Detail[ \t]*\n+/, "");
  return [title, summary, detail].join("\n");
}

/**
 * Rebuild the holder's `## Delivered` list from its group members: one bullet
 * per member, in group-date order, linking the member's entry (links the
 * existing bullet already had stay). Other bullets stay above them. The file is
 * rewritten only when the list changes. Returns true when it was.
 */
export function syncDelivered(roots: KbRoots, domain: string, holderKey: string): boolean {
  const members = groupMembers(roots, domain, holderKey);
  if (members.length === 0) return false;
  const holderId = anchorIndex(roots, domain).byKey.get(holderKey);
  if (!holderId) return false;
  const file = join(entriesDir(roots, domain), `${holderId}.md`);
  if (!existsSync(file)) return false;
  const md = readFileSync(file, "utf-8");
  const { body } = parseFrontmatter(md);

  const titleOf = (id: string): string => {
    try {
      return String(parseFrontmatter(readFileSync(join(entriesDir(roots, domain), `${id}.md`), "utf-8")).fields.title ?? id);
    } catch {
      return id;
    }
  };
  const existing = deliveredBullets(body);
  const used = new Set<DeliveredBullet>();
  const ordered: DeliveredBullet[] = members.map((m) => {
    const title = titleOf(m.id);
    const had = existing.find((b) => !used.has(b) && (b.links.includes(m.id) || normTitle(b.title) === normTitle(title)));
    if (had) used.add(had);
    return { title, links: [...new Set([...(had?.links ?? []), m.id])] };
  });
  // Bullets that are no member's stay where they were, above the members'.
  const others = existing.filter((b) => !used.has(b));
  const next = setDelivered(body, [...others, ...ordered]);
  if (next === body) return false;

  let out = md.replace(body, next);
  const fm = /^---\n([\s\S]*?)\n---/.exec(out)?.[1] ?? "";
  if (/^contentHash:/m.test(fm)) out = out.replace(/^contentHash: .*$/m, `contentHash: ${contentHash(hashedText(out))}`);
  if (out === md) return false;
  snapshotIfChanged(roots, domain, holderId, md, out);
  atomicWrite(file, out);
  return true;
}
