"use client";

/**
 * THE GRADUATION JOBS OF THIS CONSOLE, keyed by feature id. Preview and confirm run as background jobs on the wolf; this
 * store starts them, polls their status (about every 2 s) and keeps the outcome, so the Work list and the graph pane
 * show the same state for a feature and it survives closing and reopening the Work view (the store lives at module
 * level, not in a component). A page reload recovers it from the wolf (`recover`).
 *
 * phase: previewing (preview job running) → ready (Review) → graduating (confirm job running) → done (removed, toast).
 * An error keeps the phase it happened in so the owner can retry from the right place.
 */
import { useCallback, useSyncExternalStore } from "react";
import { graduationWolf, type GraduationPreview, type GraduationResult } from "@/src/core";
import type { GraduateClient } from "./graduate-client";
import { notifyGraduated } from "./graduation-signal";
import type { KbResult } from "./kb-client";

export interface GraduateTarget {
	id: string;
	title: string;
	assignee?: string;
}

export type GraduateJobState =
	| { phase: "previewing"; wolf: string; title: string }
	| { phase: "ready"; wolf: string; title: string; preview: GraduationPreview }
	| { phase: "graduating"; wolf: string; title: string; preview?: GraduationPreview }
	| { phase: "error"; wolf: string; title: string; during: "preview" | "confirm"; message: string; code?: string; preview?: GraduationPreview };

/** A graduation that went through: the toast tells the owner what was sent and that the KB follows the librarian's sweep. */
export interface GraduateDone {
	id: string;
	title: string;
	wolf: string;
	result: GraduationResult;
}

const POLL_MS = 2000;
/** Status reads that fail in a row before the job is reported as lost. */
const MAX_READ_FAILURES = 5;

export class GraduateStore {
	pollMs = POLL_MS;
	private readonly jobs = new Map<string, GraduateJobState>();
	private done: GraduateDone[] = [];
	private readonly listeners = new Set<() => void>();
	/** Bumped on every transition of an id: a poller of an older generation stops. */
	private readonly gen = new Map<string, number>();
	private readonly recovering = new Set<string>();
	private wolvesMemo = new WeakMap<GraduateClient, { at: number; p: ReturnType<GraduateClient["wolves"]> }>();

	subscribe = (fn: () => void): (() => void) => {
		this.listeners.add(fn);
		return () => void this.listeners.delete(fn);
	};
	get = (id: string): GraduateJobState | undefined => this.jobs.get(id);
	getDone = (): readonly GraduateDone[] => this.done;

	private emit(): void {
		for (const l of [...this.listeners]) l();
	}
	private set(id: string, state: GraduateJobState | undefined): number {
		if (state) this.jobs.set(id, state);
		else this.jobs.delete(id);
		const g = (this.gen.get(id) ?? 0) + 1;
		this.gen.set(id, g);
		this.emit();
		return g;
	}
	private current(id: string, g: number): boolean {
		return this.gen.get(id) === g;
	}

	/** Forget everything (tests). */
	reset(): void {
		for (const id of this.jobs.keys()) this.gen.set(id, (this.gen.get(id) ?? 0) + 1);
		this.jobs.clear();
		this.done = [];
		this.recovering.clear();
		this.wolvesMemo = new WeakMap();
		this.emit();
	}

	dismissDone(id: string): void {
		this.done = this.done.filter((d) => d.id !== id);
		this.emit();
	}

	/** Start the preview job of a feature on `wolf`; the loader shows until the status reports it. */
	async startPreview(client: GraduateClient, target: GraduateTarget, wolf: string): Promise<void> {
		const g = this.set(target.id, { phase: "previewing", wolf, title: target.title });
		const res = await client.startPreview(wolf, target.id);
		if (!this.current(target.id, g)) return;
		if (!res.ok) return void this.fail(target.id, { wolf, title: target.title }, "preview", res);
		void this.poll(client, target.id, wolf, g);
	}

	/** Send the reviewed preview: the confirm job runs in the background and the loader shows again. */
	async confirm(client: GraduateClient, id: string): Promise<void> {
		const cur = this.jobs.get(id);
		if (cur?.phase !== "ready") return;
		const { wolf, title, preview } = cur;
		const g = this.set(id, { phase: "graduating", wolf, title, preview });
		const res = await client.startConfirm(wolf, id, preview.token);
		if (!this.current(id, g)) return;
		if (!res.ok) return void this.fail(id, { wolf, title, preview }, "confirm", res);
		void this.poll(client, id, wolf, g);
	}

	/**
	 * The owner retries after an error. Returns where to go: "graduate" (the confirmation step: the preview is gone or
	 * stale) or "review" (the preview is still good: the confirm failed, nothing was archived).
	 */
	retry(id: string): "graduate" | "review" {
		const cur = this.jobs.get(id);
		if (cur?.phase === "error" && cur.during === "confirm" && cur.preview && cur.code !== "preview_stale") {
			this.set(id, { phase: "ready", wolf: cur.wolf, title: cur.title, preview: cur.preview });
			return "review";
		}
		this.set(id, undefined);
		return "graduate";
	}

	/**
	 * Pick up a job the wolf already has for this feature (the console was reloaded, or the Work view was never open):
	 * a finished preview shows as Review, a running job shows its loader. Only for an online assignee; ignores the rest.
	 */
	async recover(client: GraduateClient, target: GraduateTarget): Promise<void> {
		const id = target.id;
		if (this.jobs.has(id) || this.recovering.has(id) || !target.assignee) return;
		this.recovering.add(id);
		try {
			const choice = graduationWolf(target.assignee, await this.wolves(client));
			if (choice.kind !== "assignee") return;
			const res = await client.status(choice.wolf, id);
			if (!res.ok || this.jobs.has(id)) return;
			const s = res.data;
			if (s.state === "preview_ready") this.set(id, { phase: "ready", wolf: choice.wolf, title: target.title, preview: s.preview });
			else if (s.state === "running") {
				const g = this.set(id, s.kind === "preview" ? { phase: "previewing", wolf: choice.wolf, title: target.title } : { phase: "graduating", wolf: choice.wolf, title: target.title });
				void this.poll(client, id, choice.wolf, g);
			}
		} finally {
			this.recovering.delete(id);
		}
	}

	/** The wolves, read at most every 5 s per client (every ready feature row asks). */
	private wolves(client: GraduateClient) {
		const hit = this.wolvesMemo.get(client);
		if (hit && Date.now() - hit.at < 5000) return hit.p;
		const p = client.wolves().catch(() => []);
		this.wolvesMemo.set(client, { at: Date.now(), p });
		return p;
	}

	private fail(id: string, base: { wolf: string; title: string; preview?: GraduationPreview }, during: "preview" | "confirm", res: Extract<KbResult<unknown>, { ok: false }>): void {
		this.set(id, { phase: "error", wolf: base.wolf, title: base.title, during, message: res.message, ...(res.code ? { code: res.code } : {}), ...(base.preview ? { preview: base.preview } : {}) });
	}

	private async poll(client: GraduateClient, id: string, wolf: string, g: number): Promise<void> {
		let failures = 0;
		for (;;) {
			const res = await client.status(wolf, id);
			if (!this.current(id, g)) return;
			const cur = this.jobs.get(id);
			if (!cur || (cur.phase !== "previewing" && cur.phase !== "graduating")) return;
			if (!res.ok) {
				if (++failures >= MAX_READ_FAILURES) return void this.fail(id, cur, cur.phase === "previewing" ? "preview" : "confirm", res);
			} else {
				failures = 0;
				const s = res.data;
				if (s.state === "preview_ready" && cur.phase === "previewing") {
					this.set(id, { phase: "ready", wolf, title: cur.title, preview: s.preview });
					return;
				}
				if (s.state === "graduated") {
					this.set(id, undefined);
					this.done = [...this.done.filter((d) => d.id !== id), { id, title: cur.title, wolf, result: s.result }];
					this.emit();
					notifyGraduated(id);
					return;
				}
				if (s.state === "error") {
					return void this.fail(id, cur, s.kind, { ok: false, reason: "error", message: s.message, code: s.code });
				}
				if (s.state === "none") {
					return void this.fail(id, cur, cur.phase === "previewing" ? "preview" : "confirm", { ok: false, reason: "error", message: `${wolf} lost the graduation job (it restarted?). Try again.` });
				}
			}
			await new Promise((r) => setTimeout(r, this.pollMs));
			if (!this.current(id, g)) return;
		}
	}
}

/** The one store of this console. */
export const graduateStore = new GraduateStore();

/** The graduation job of a feature, live. */
export function useGraduateJob(id: string): GraduateJobState | undefined {
	const get = useCallback(() => graduateStore.get(id), [id]);
	return useSyncExternalStore(graduateStore.subscribe, get, get);
}

/** The graduations that went through and have not been dismissed. */
export function useGraduateDone(): readonly GraduateDone[] {
	return useSyncExternalStore(graduateStore.subscribe, graduateStore.getDone, graduateStore.getDone);
}
