/**
 * stage-sync — a feature follows its tasks into build.
 *
 * Once work on a task is under way (it moves to in_build, or it is bound and
 * noted), its ancestors that are still before build move to in_build too.
 * Never moves anything backwards and leaves holding containers (the Inbox) alone.
 */
import type { WorkItem } from "@wolfpack/kb/client";

/** Stages before build; an ancestor in one of these follows its task. */
export const BEFORE_BUILD = ["idea", "plan", "feasibility", "approved"];

/** The slice of the Work API that stage sync needs. */
export interface StageSyncClient {
  get(id: string): Promise<WorkItem>;
  stage(id: string, to: string): Promise<WorkItem>;
}

/**
 * Move the task's ancestors to in_build when they are still before build.
 * Returns the ancestors it moved. Best effort: a failure stops the walk.
 */
export async function syncFeatureStage(client: StageSyncClient, task: WorkItem): Promise<WorkItem[]> {
  const moved: WorkItem[] = [];
  let parentId = task.partOf as string | null | undefined;
  while (parentId) {
    let parent: WorkItem;
    try {
      parent = await client.get(parentId);
    } catch {
      break;
    }
    if (!parent.container && BEFORE_BUILD.includes(parent.stage)) {
      try {
        moved.push(await client.stage(parent.id as string, "in_build"));
      } catch {
        break;
      }
    }
    parentId = (parent.partOf as string | null | undefined) ?? null;
  }
  return moved;
}
