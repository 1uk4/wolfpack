import type { ComponentType } from "react";
import type { ArtifactPartProps } from "@/src/core";
import { ToolCallCard } from "@/components/artifacts/tool-call-card";

/**
 * Artifact renderer registry — the extension point for tool-part UI.
 *
 * chat.tsx renders any tool part it doesn't specially handle (i.e. not a
 * question tool) by looking the tool name up here. Add your renderer — do
 * NOT edit chat.tsx.
 *
 * Typical shape: while the part is input-available render an activity card
 * (the chat view's jobs feed reads GET /api/jobs?chatId=…; on completion call
 * ChatActionsContext.syncFromServer()); when output-available render the
 * artifact itself from part.output. Job tools register JobCard
 * (components/artifacts/job-card.tsx) under their tool name.
 */
export const artifactRenderers: Record<string, ComponentType<ArtifactPartProps>> = {
	// The filesystem set: one quiet expandable tool-call card each —
	// collapsed one-liner (tool name + headline argument), full
	// input/output on expand.
	read: ToolCallCard,
	ls: ToolCallCard,
	find: ToolCallCard,
	grep: ToolCallCard,
};
