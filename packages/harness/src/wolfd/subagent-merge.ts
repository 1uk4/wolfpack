/**
 * Merge on ship (ticket 8): detecting the ship, and the words the parent is told. The git work is the workspaces
 * package's (mergeChild, abandonChild); the orchestration is SubagentManager's.
 */
import type { ThreadEvent } from "@wolfpack/protocol";
import type { Workspace } from "@wolfpack/workspaces";
import type { ChildRecord } from "./subagent-store.js";

/**
 * Watches one thread's events for a successful task_done and returns the shipped work id. The memory extension's
 * result line `Shipped: <id>` (unified-tasks, the durable task_done) is the contract (its own spent-yes check reads it too); a declined, held or failed
 * ship never starts with it.
 */
// (The legacy terminal-pi task_done in work-system.ts says "✓ Shipped: <title>", with no id; it never runs on wolfd.)
export class ShipEvents {
  private readonly names = new Map<string, string>();
  see(ev: ThreadEvent): string | undefined {
    if (ev.type === "tool-start") {
      this.names.set(ev.callId, ev.name);
      return undefined;
    }
    if (ev.type !== "tool-end") return undefined;
    const name = this.names.get(ev.callId);
    this.names.delete(ev.callId);
    if (name !== "task_done" || ev.isError) return undefined;
    return /^Shipped: (\S+)/.exec(ev.result)?.[1];
  }
}

export const mergedText = (ws: Workspace, feature: Workspace, commits: number): string =>
  `Merged ${ws.branch} into ${feature.branch} (${commits} commit${commits === 1 ? "" : "s"}); its worktree and branch are removed.`;

export function homeText(rec: ChildRecord, ws: Workspace): string {
  return (
    `Not merged: sub-agent "${rec.name}" worked on ${ws.branch}, cut from the home checkout, so there is no feature branch to merge it into. ` +
    `Its worktree is ${ws.path}. Merge it by hand when the owner is ready: git -C ${ws.repo.mainDir} merge ${ws.branch}; then remove it with subagent_stop({ name: "${rec.name}", abandon: true }) or git worktree remove ${ws.path} && git branch -d ${ws.branch}.`
  );
}

export function dirtyText(rec: ChildRecord, ws: Workspace, reason: string): string {
  return (
    `Not merged: ${reason}. Nothing was changed. Commit or stash the uncommitted work first (in the child worktree ${ws.path}, or in the feature worktree if that is the dirty one), ` +
    `then call subagent_merge({ name: "${rec.name}", action: "retry" }).`
  );
}

export function conflictText(rec: ChildRecord, ws: Workspace, feature: Workspace, files: string[]): string {
  const title = `Merge conflict merging ${ws.branch} into ${feature.branch}: ${files.join(", ")}`;
  const options = [
    { label: "Resolve with a worker", value: "resolve", description: "A worker subagent rebases the branch onto the feature branch, resolves and commits; then it is merged again." },
    { label: "I'll do it", value: "manual", description: "Leave the worktree and branch; you get the path and commands." },
    { label: "Abandon branch", value: "abandon", description: "Discard the worktree and branch." },
  ];
  return (
    `${title}. The merge stopped and both trees are clean.\n\n` +
    `Ask the user what to do with ONE ask_user_question call: question ${JSON.stringify(title)}, options ${JSON.stringify(options)}. Then act on the answer:\n` +
    `- resolve: subagent_merge({ name: "${rec.name}", action: "resolve" })\n` +
    `- manual: subagent_merge({ name: "${rec.name}", action: "manual" }) and pass its steps on to the user\n` +
    `- abandon: subagent_merge({ name: "${rec.name}", action: "abandon" })`
  );
}

export function manualText(ws: Workspace, feature: Workspace): string {
  return (
    `Left as is: worktree ${ws.path} on ${ws.branch}. Tell the user to resolve it:\n` +
    `  cd ${ws.path}\n  git rebase ${feature.branch}   # fix the conflicts, git add, git rebase --continue\n` +
    `  git -C ${feature.path} merge --ff-only ${ws.branch}\n` +
    `Then ask you to clean up (subagent_stop with abandon: true), or call subagent_merge with action "retry" once the rebase is done.`
  );
}

export const conflictBrief = (ws: Workspace, feature: Workspace): string =>
  `Resolve a merge conflict. You are in the git worktree ${ws.path} on branch ${ws.branch}. Run \`git rebase ${feature.branch}\`, resolve every conflict keeping the intent of both sides, ` +
  `\`git add\` the files and \`git rebase --continue\` until the rebase is complete, and make sure the tree is clean and the tests you can run still pass. ` +
  `Do not switch branches, push, or touch other worktrees. Reply with what you resolved.`;
