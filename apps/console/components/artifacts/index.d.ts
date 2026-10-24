import type { ComponentType } from "react";
import type { ArtifactPartProps } from "@/src/core";
/**
 * Artifact renderer registry — the extension point for tool-part UI.
 *
 * chat.tsx renders any tool part it doesn't specially handle (i.e. not
 * quiz/ask) by looking the tool name up here. Add your renderer — do NOT
 * edit chat.tsx (see docs/plan.md file-ownership rules).
 *
 * Typical shape: while the part is input-available render an activity card
 * (the chat view's jobs feed reads GET /api/jobs?chatId=…; on completion call
 * ChatActionsContext.syncFromServer()); when output-available render the
 * artifact itself from part.output.
 */
export declare const artifactRenderers: Record<string, ComponentType<ArtifactPartProps>>;
//# sourceMappingURL=index.d.ts.map