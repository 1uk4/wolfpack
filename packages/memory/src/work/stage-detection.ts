/**
 * stage-detection.ts — Auto-detect stage transitions and prompt for confirmation
 * 
 * Analyzes work item state and conversation to detect when a stage transition
 * is appropriate, then prompts the user for confirmation.
 */
import type { WorkItem } from "@wolfpack/kb/client";
import { BREAKDOWN_SUGGESTION_SYSTEM } from "../config/prompts/tasks.js";

export { BREAKDOWN_SUGGESTION_SYSTEM };

// ════════════════════════════════════════════════════════════════════════════
// 1 · TRANSITION DETECTION RULES
// ════════════════════════════════════════════════════════════════════════════

export interface TransitionSignal {
  from: string;
  to: string;
  confidence: "high" | "medium" | "low";
  reason: string;
  prompt: string;
}

/**
 * Detect if a stage transition is appropriate based on work item state
 */
export function detectTransition(
  item: WorkItem,
  context: {
    bodyLength: number;
    hasSuccessCriteria: boolean;
    childCount: number;
    completedChildCount: number;
    hasOpenQuestions: boolean;
    recentActivity: string[];
  }
): TransitionSignal | null {
  const { bodyLength, hasSuccessCriteria, childCount, completedChildCount, hasOpenQuestions, recentActivity } = context;

  switch (item.stage) {
    // ─────────────────────────────────────────────────────────────────────────
    // IDEA → PLAN: scope is defined
    // ─────────────────────────────────────────────────────────────────────────
    case "idea": {
      const hasScope = bodyLength > 200;
      const hasDirection = !hasOpenQuestions || recentActivity.some(a => 
        a.includes("defined") || a.includes("scope") || a.includes("requirements")
      );
      
      if (hasScope && hasDirection) {
        return {
          from: "idea",
          to: "plan",
          confidence: hasSuccessCriteria ? "high" : "medium",
          reason: "Scope appears defined with clear direction",
          prompt: `📋 Scope looks defined for "${item.title}". Ready to move to planning?`,
        };
      }
      break;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PLAN → FEASIBILITY or IN_BUILD: plan is complete
    // ─────────────────────────────────────────────────────────────────────────
    case "plan": {
      const hasPlan = bodyLength > 500;
      const hasChildren = childCount > 0;
      const hasAllCriteria = hasSuccessCriteria;

      if (hasPlan && hasChildren && hasAllCriteria) {
        // Has children → likely a feature/initiative, may need feasibility
        if (item.kind === "feature" || item.kind === "initiative") {
          return {
            from: "plan",
            to: "feasibility",
            confidence: "medium",
            reason: "Plan complete with tasks defined",
            prompt: `🔍 Plan for "${item.title}" looks complete. Validate feasibility before building?`,
          };
        }
        // Task → straight to in_build
        return {
          from: "plan",
          to: "in_build",
          confidence: "high",
          reason: "Plan complete, ready to implement",
          prompt: `🚀 Plan for "${item.title}" is ready. Start building?`,
        };
      }

      // Suggest creating children if in planning but no children yet
      if (hasPlan && !hasChildren && (item.kind === "feature" || item.kind === "initiative")) {
        return {
          from: "plan",
          to: "plan", // Stay in plan, but prompt for children
          confidence: "medium",
          reason: "Plan exists but no tasks defined",
          prompt: `📝 "${item.title}" has a plan but no tasks. Want to break it down into tasks?`,
        };
      }
      break;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FEASIBILITY → APPROVED: validated
    // ─────────────────────────────────────────────────────────────────────────
    case "feasibility": {
      const hasFindings = recentActivity.some(a => 
        a.includes("validated") || a.includes("feasible") || a.includes("approved") || a.includes("go")
      );
      
      if (hasFindings) {
        return {
          from: "feasibility",
          to: "approved",
          confidence: "medium",
          reason: "Feasibility validated",
          prompt: `✅ "${item.title}" looks validated. Approve for implementation?`,
        };
      }
      break;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // APPROVED → IN_BUILD: start work
    // ─────────────────────────────────────────────────────────────────────────
    case "approved": {
      // This is typically manual - wolf decides when to start
      // But if they're actively working, prompt
      const isWorking = recentActivity.some(a => 
        a.includes("implement") || a.includes("building") || a.includes("working on")
      );
      
      if (isWorking) {
        return {
          from: "approved",
          to: "in_build",
          confidence: "high",
          reason: "Active implementation detected",
          prompt: `🔨 Looks like you're building "${item.title}". Move to in_build?`,
        };
      }
      break;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // IN_BUILD → SHIPPED: work complete
    // ─────────────────────────────────────────────────────────────────────────
    case "in_build": {
      // For tasks: success criteria met
      if (item.kind === "task") {
        const criteriaMetSignals = recentActivity.some(a => 
          a.includes("done") || a.includes("complete") || a.includes("finished") || 
          a.includes("working") || a.includes("implemented")
        );
        
        if (criteriaMetSignals && hasSuccessCriteria) {
          return {
            from: "in_build",
            to: "shipped",
            confidence: "medium",
            reason: "Task appears complete",
            prompt: `📦 "${item.title}" looks done. Mark as shipped?`,
          };
        }
      }

      // For features/initiatives: all children complete
      if ((item.kind === "feature" || item.kind === "initiative") && childCount > 0) {
        if (completedChildCount === childCount) {
          return {
            from: "in_build",
            to: "shipped",
            confidence: "high",
            reason: "All child items complete",
            prompt: `📦 All tasks under "${item.title}" are done. Ship the ${item.kind}?`,
          };
        }
      }
      break;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SHIPPED → LIVE: deployed
    // ─────────────────────────────────────────────────────────────────────────
    case "shipped": {
      const deployed = recentActivity.some(a => 
        a.includes("deployed") || a.includes("live") || a.includes("production")
      );
      
      if (deployed) {
        return {
          from: "shipped",
          to: "live",
          confidence: "medium",
          reason: "Deployment detected",
          prompt: `🚀 "${item.title}" appears deployed. Mark as live?`,
        };
      }
      break;
    }
  }

  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// 2 · CONTEXT EXTRACTION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Extract context from work item body for transition detection
 */
export function extractTransitionContext(
  item: WorkItem,
  body: string,
  children: WorkItem[],
  recentNotes: string[]
): Parameters<typeof detectTransition>[1] {
  const completedStages = ["shipped", "live", "archived"];
  const safeChildren = children ?? [];
  
  return {
    bodyLength: body.length,
    hasSuccessCriteria: !!item.successCriteria,
    childCount: safeChildren.length,
    completedChildCount: safeChildren.filter(c => completedStages.includes(c.stage)).length,
    hasOpenQuestions: body.toLowerCase().includes("?") || body.toLowerCase().includes("tbd"),
    recentActivity: recentNotes,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 3 · CHILD BREAKDOWN SUGGESTION
// ════════════════════════════════════════════════════════════════════════════

export interface BreakdownSuggestion {
  parentId: string;
  parentTitle: string;
  suggestedChildren: Array<{
    title: string;
    kind: "feature" | "task";
    successCriteria?: string;
  }>;
  prompt: string;
}

