/**
 * The graduation data seam: which wolves are online, and the two graduate calls (console route → wolfd). The Work
 * list and the graph pane take it as a prop so tests inject a fake; `createGraduateClient` is the real one.
 */
import type { GraduationPreview, GraduationResult } from "@/src/core";
import { fetchWolves, postGraduateConfirm, postGraduatePreview, type KbResult } from "./kb-client";

export interface GraduateWolf {
	name: string;
	status: string;
}

export interface GraduateClient {
	wolves(): Promise<GraduateWolf[]>;
	preview(wolf: string, workId: string): Promise<KbResult<GraduationPreview>>;
	confirm(wolf: string, workId: string, token: string): Promise<KbResult<GraduationResult>>;
}

export function createGraduateClient(): GraduateClient {
	return {
		async wolves() {
			const res = await fetchWolves();
			return res.ok ? res.data.wolves : [];
		},
		preview: postGraduatePreview,
		confirm: postGraduateConfirm,
	};
}
