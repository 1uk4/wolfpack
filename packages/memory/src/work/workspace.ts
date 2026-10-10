/**
 * workspace — the read-only context an agent gets about the feature (and
 * initiative) around its bound task. The agent only ever writes to the task.
 */
import { isComplete, type WorkItem } from "@wolfpack/kb/client";
import { progress, rightRows } from "./selector.js";

const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

/**
 * The workspace block, or null when `featureId` is not a known feature.
 *   ## Workspace (read-only)
 *   Feature: Repo Cleanup & Simplification [in_build] · 6/9 tasks done · id …
 *   Initiative: Memory Extension Polish
 *   Feature done when: …
 *   Open tasks: ● bound / in progress · ○ planned · ⛔ blocked
 */
export function workspaceHeader(featureId: string | null | undefined, all: WorkItem[], boundId?: string | null): string | null {
  const feature = featureId ? all.find((i) => i.id === featureId) : undefined;
  if (!feature || feature.kind !== "feature") return null;
  const { done, total } = progress(feature, all);
  const initiative = feature.partOf ? all.find((i) => i.id === feature.partOf) : undefined;
  const lines = ["## Workspace (read-only)"];
  lines.push(
    `Feature: ${feature.container ? "Inbox (holding area for unfiled work)" : feature.title} [${feature.stage}] · ${done}/${total} tasks done · id ${feature.id}`
  );
  if (initiative) lines.push(`Initiative: ${initiative.title}`);
  if (feature.successCriteria) lines.push(`Feature done when: ${clip(feature.successCriteria, 300)}`);
  const open = rightRows(all, feature.id as string).filter((t) => !isComplete(t));
  if (open.length) {
    lines.push("Open tasks:");
    for (const t of open.slice(0, 12)) {
      const blocked = (t.dependsOn ?? []).some((d) => {
        const dep = all.find((i) => i.id === d);
        return !dep || !isComplete(dep);
      });
      const mark = t.id === boundId ? "● (bound)" : blocked ? "⛔" : ["plan", "idea"].includes(t.stage) ? "○" : "●";
      lines.push(`  ${mark} ${t.title} [${t.stage}]`);
    }
    if (open.length > 12) lines.push(`  … +${open.length - 12} more`);
  }
  return lines.join("\n");
}
