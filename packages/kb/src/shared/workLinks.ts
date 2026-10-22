/**
 * Work links — the note format that records which KB entries a graduated work
 * item created or updated. Pure: shared by Dewey (writes the notes, see
 * librarian/work-links.ts) and the wolves (read them back).
 *
 *     KB: created kb-wolfpack-X
 *     KB: updated kb-wolfpack-Y
 */

export interface WorkLink {
  workId: string;
  entryId: string;
  action: "created" | "updated";
}

/** The work item a den topic id belongs to: `work-<domain>-<id>` or `…~<slug>`. */
export function workIdOfTopic(denTopicId: string): string | null {
  return /^(work-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9A-Za-z]{7})(?:~.+)?$/.exec(denTopicId)?.[1] ?? null;
}

/** The note text for one link. */
export const linkNote = (l: Pick<WorkLink, "action" | "entryId">): string => `KB: ${l.action} ${l.entryId}`;

/** Every `KB:` note of a work item's log, as the entries it created and updated (in order, unique). */
export function parseKbNotes(log: Array<{ text: string }> | undefined): { created: string[]; updated: string[]; all: string[] } {
  const created: string[] = [];
  const updated: string[] = [];
  for (const { text } of log ?? []) {
    if (!/^KB:/.test(text)) continue;
    for (const m of text.matchAll(/\b(created|updated) (kb-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9A-Za-z]{7})\b/g)) {
      const into = m[1] === "created" ? created : updated;
      if (!into.includes(m[2])) into.push(m[2]);
    }
  }
  const all = [...new Set([...created, ...updated])];
  return { created, updated, all };
}
