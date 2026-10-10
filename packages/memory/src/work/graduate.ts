/**
 * graduate.ts — Graduate completed work items to KB entries
 * 
 * Features and initiatives graduate to KB entries when completed.
 * Tasks don't graduate directly - they embed in their parent feature.
 * 
 * Graduation order:
 * 1. If feature has initiative parent → graduate initiative first
 * 2. Graduate feature with reference to initiative entry
 * 3. Dewey processes and places appropriately
 */
import { isComplete, type WorkItem, type WorkId } from "@wolfpack/kb/client";

// ════════════════════════════════════════════════════════════════════════════
// 1 · GRADUATION ELIGIBILITY
// ════════════════════════════════════════════════════════════════════════════

const GRADUATABLE_KINDS = ["feature", "initiative"];

/**
 * After a child ships: is its parent a feature/initiative whose children are
 * now ALL complete, but which has not shipped itself yet? Then it is ready to
 * ship — and shipping it graduates it into the KB.
 */
export function parentReadyToShip(
  parent: WorkItem | undefined,
  children: WorkItem[]
): parent is WorkItem {
  return (
    !!parent &&
    GRADUATABLE_KINDS.includes(parent.kind) &&
    !isComplete(parent) &&
    children.length > 0 &&
    children.every(isComplete)
  );
}

/**
 * Check if a work item is eligible for graduation
 */
export function canGraduate(item: WorkItem): boolean {
  // Must be complete
  if (!isComplete(item)) return false;
  
  // Must be feature or initiative (tasks embed in parent)
  if (!GRADUATABLE_KINDS.includes(item.kind)) return false;
  
  // Must not already be graduated
  if (item.graduatedTo.length > 0) return false;
  
  return true;
}

/**
 * Check if parent initiative needs to graduate first
 */
export function needsParentFirst(
  item: WorkItem,
  getItem: (id: WorkId) => WorkItem | undefined
): { needsParent: boolean; parent?: WorkItem } {
  if (!item.partOf) return { needsParent: false };
  
  const parent = getItem(item.partOf as WorkId);
  if (!parent) return { needsParent: false };
  
  // Only initiatives are parents that need to graduate first
  if (parent.kind !== "initiative") return { needsParent: false };
  
  // Check if parent is already graduated
  if (parent.graduatedTo.length > 0) return { needsParent: false };
  
  return { needsParent: true, parent };
}

// ════════════════════════════════════════════════════════════════════════════
// 2 · CONTRIBUTION BUILDING
// ════════════════════════════════════════════════════════════════════════════

export interface GraduationContribution {
  /** Work item id (used as denTopicId for contribution) */
  workId: string;
  /** Domain hint for KB routing */
  domain: string;
  /** Title for the KB entry */
  title: string;
  /** Summary line (≤140 chars) */
  summary: string;
  /** Full body content */
  body: string;
  /** Parent entry id if this graduates under an initiative */
  parentEntryId?: string;
  /** Related entry ids (e.g., KB entries referenced during work) */
  references: string[];
}

/**
 * Build a contribution from a completed work item
 */
export function buildContribution(
  item: WorkItem,
  body: string,
  parentEntryId?: string
): GraduationContribution {
  return {
    workId: item.id,
    domain: item.domain,
    title: item.title,
    summary: item.summary || deriveSummary(item, body),
    body: cleanBodyForKB(body, item),
    parentEntryId,
    references: item.references ?? [],
  };
}

/**
 * Derive a summary from the work item if not set
 */
function deriveSummary(item: WorkItem, body: string): string {
  // Try to extract first meaningful line from body
  const lines = body.split("\n").filter(l => 
    l.trim() && 
    !l.startsWith("#") && 
    !l.startsWith("-") &&
    l.length > 20
  );
  
  if (lines.length > 0) {
    const first = lines[0].trim();
    return first.length > 140 ? first.slice(0, 137) + "..." : first;
  }
  
  // Fall back to title + kind
  return `${item.kind}: ${item.title}`.slice(0, 140);
}

/**
 * Clean up work item body for KB entry
 * Remove temporal language, in-progress markers, etc.
 */
function cleanBodyForKB(body: string, item: WorkItem): string {
  let cleaned = body;
  
  // TODO: Use LLM to rewrite body for KB (clean prose, no work IDs)
  // For now, basic cleanup only
  
  // Remove "## Implementation Log" header (content stays)
  cleaned = cleaned.replace(/^## Implementation Log\s*\n/gm, "## Implementation\n");
  
  // Remove task completion timestamps (keep content)
  cleaned = cleaned.replace(/_Completed \d{4}-\d{2}-\d{2}_\n/g, "");
  
  // Add metadata header if not present
  if (!cleaned.startsWith("#")) {
    cleaned = `# ${item.title}\n\n${cleaned}`;
  }
  
  // Add success criteria if present
  if (item.successCriteria && !cleaned.includes(item.successCriteria)) {
    cleaned = cleaned.replace(
      /^(# .+\n)/,
      `$1\n**Criteria:** ${item.successCriteria}\n`
    );
  }
  
  return cleaned.trim();
}

// ════════════════════════════════════════════════════════════════════════════
// 3 · GRADUATION ORCHESTRATION
// ════════════════════════════════════════════════════════════════════════════

export interface GraduationResult {
  graduated: Array<{
    workId: string;
    entryId: string;
    kind: string;
    title: string;
  }>;
  skipped: Array<{
    workId: string;
    reason: string;
  }>;
}

export interface GraduationContext {
  getItem: (id: WorkId) => WorkItem | undefined;
  getBody: (id: WorkId) => string;
  getChildren: (parentId: WorkId) => WorkItem[];
  /** Submit contribution to KB (returns entry id) */
  submitToKB: (contribution: GraduationContribution) => Promise<string>;
  /** Mark work item as graduated */
  markGraduated: (workId: WorkId, entryId: string) => void;
}

/**
 * Graduate a work item (and parent if needed)
 */
export async function graduateWorkItem(
  item: WorkItem,
  ctx: GraduationContext
): Promise<GraduationResult> {
  const result: GraduationResult = { graduated: [], skipped: [] };
  
  // Check eligibility
  if (!canGraduate(item)) {
    result.skipped.push({
      workId: item.id,
      reason: item.graduatedTo.length > 0 
        ? "already graduated" 
        : `not eligible (stage: ${item.stage}, kind: ${item.kind})`,
    });
    return result;
  }
  
  // Check if parent needs to graduate first
  const { needsParent, parent } = needsParentFirst(item, ctx.getItem);
  let parentEntryId: string | undefined;
  
  if (needsParent && parent) {
    // Graduate parent first
    const parentBody = ctx.getBody(parent.id as WorkId);
    const parentContrib = buildContribution(parent, parentBody);
    
    try {
      parentEntryId = await ctx.submitToKB(parentContrib);
      ctx.markGraduated(parent.id as WorkId, parentEntryId);
      result.graduated.push({
        workId: parent.id,
        entryId: parentEntryId,
        kind: parent.kind,
        title: parent.title,
      });
    } catch (e: any) {
      result.skipped.push({
        workId: parent.id,
        reason: `failed to graduate parent: ${e.message}`,
      });
      // Continue with feature anyway (Dewey can handle orphan)
    }
  } else if (item.partOf) {
    // Parent already graduated, get its entry id
    const parent = ctx.getItem(item.partOf as WorkId);
    if (parent && parent.graduatedTo.length > 0) {
      parentEntryId = parent.graduatedTo[0];
    }
  }
  
  // Graduate the item
  const body = ctx.getBody(item.id as WorkId);
  const contribution = buildContribution(item, body, parentEntryId);
  
  try {
    const entryId = await ctx.submitToKB(contribution);
    ctx.markGraduated(item.id as WorkId, entryId);
    result.graduated.push({
      workId: item.id,
      entryId,
      kind: item.kind,
      title: item.title,
    });
  } catch (e: any) {
    result.skipped.push({
      workId: item.id,
      reason: `failed to graduate: ${e.message}`,
    });
  }
  
  return result;
}

/**
 * Check for any work items ready to graduate and process them
 */
export async function processGraduationQueue(
  items: WorkItem[],
  ctx: GraduationContext
): Promise<GraduationResult> {
  const result: GraduationResult = { graduated: [], skipped: [] };
  
  // Filter to eligible items
  const eligible = items.filter(canGraduate);
  
  // Sort: initiatives first, then features
  eligible.sort((a, b) => {
    if (a.kind === "initiative" && b.kind !== "initiative") return -1;
    if (a.kind !== "initiative" && b.kind === "initiative") return 1;
    return 0;
  });
  
  // Process each
  for (const item of eligible) {
    const itemResult = await graduateWorkItem(item, ctx);
    result.graduated.push(...itemResult.graduated);
    result.skipped.push(...itemResult.skipped);
  }
  
  return result;
}
