/**
 * The graduation data seam: which wolves are online, and the graduate calls (console route → wolfd). Preview and
 * confirm START a background job on the wolf and answer at once; `status` is how their outcome is read. The Work
 * list and the graph pane take it as a prop so tests inject a fake; `createGraduateClient` is the real one.
 */
import type { GraduationJob, GraduationObservations, GraduationStatus } from "@/src/core";
import { fetchGraduateObservations, fetchGraduateStatus, fetchWolves, postGraduateConfirm, postGraduatePreview, type KbResult } from "./kb-client";

export interface GraduateWolf {
	name: string;
	status: string;
}

export interface GraduateClient {
	wolves(): Promise<GraduateWolf[]>;
	/** Start the preview job (the running one if it already runs). */
	startPreview(wolf: string, workId: string): Promise<KbResult<GraduationJob>>;
	/** Start the confirm job for a previewed graduation. */
	startConfirm(wolf: string, workId: string, token: string): Promise<KbResult<GraduationJob>>;
	status(wolf: string, workId: string): Promise<KbResult<GraduationStatus>>;
	/** Pending observations in that wolf's pool a graduation of the feature would fold. */
	observations(wolf: string, workId: string): Promise<KbResult<GraduationObservations>>;
}

export function createGraduateClient(): GraduateClient {
	return {
		async wolves() {
			const res = await fetchWolves();
			return res.ok ? res.data.wolves : [];
		},
		startPreview: postGraduatePreview,
		startConfirm: postGraduateConfirm,
		status: fetchGraduateStatus,
		observations: fetchGraduateObservations,
	};
}
