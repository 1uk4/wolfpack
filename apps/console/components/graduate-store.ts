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
import { graduationWolf, type GraduationPreview, type GraduationResult, type GraduationStatus } from "@/src/core";
import type { GraduateClient } from "./graduate-client";
import { notifyGraduated } from "./graduation-signal";
import type { KbResult } from "./kb-client";

export interface GraduateTarget {
	id: string;
	title: string;
	assignee?: string;
}

/** A send that failed and left its preview valid: Review shows it so the fallback never looks like a fresh preview. */
export interface LastError {
	kind: string;
	code?: string;
	message: string;
}

export type GraduateJobState =
	| { phase: "previewing"; wolf: string; title: string; note?: string }
	| { phase: "ready"; wolf: string; title: string; preview: GraduationPreview; lastError?: LastError }
	| { phase: "graduating"; wolf: string; title: string; preview?: GraduationPreview; note?: string }
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
/** The longest a poll waits for one job: the wolf's drain timeout (3 min) twice, plus a margin for the model and the Work API. */
const DEADLINE_MS = 10 * 60 * 1000;

type Failure = Extract<KbResult<unknown>, { ok: false }>;
const thrown = (e: unknown): Failure => ({ ok: false, reason: "error", message: e instanceof Error ? e.message : String(e) });

export class GraduateStore {
	pollMs = POLL_MS;
	deadlineMs = DEADLINE_MS;
	/** Bumped by reset(): a recover() that started before it must not write after it. */
	private epoch = 0;
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
		this.epoch++;
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

	/**
	 * The job the wolf says is running (a start was refused as busy, or answered a job of the other kind): show its loader
	 * with a note and keep polling it. A running preview ends in Review, a running confirm in the graduation.
	 */
	private adopt(client: GraduateClient, id: string, base: { wolf: string; title: string; preview?: GraduationPreview }, running: "preview" | "confirm"): void {
		const note = `a ${running} is already running`;
		const g = this.set(id, running === "preview" ? { phase: "previewing", wolf: base.wolf, title: base.title, note } : { phase: "graduating", wolf: base.wolf, title: base.title, ...(base.preview ? { preview: base.preview } : {}), note });
		void this.poll(client, id, base.wolf, g);
	}

	/** The kind of job a refused start says is running ("a confirm of this feature is already running"). */
	private static runningKind(res: Failure, other: "preview" | "confirm"): "preview" | "confirm" {
		return /\bpreview\b/.test(res.message) ? "preview" : /\bconfirm\b/.test(res.message) ? "confirm" : other;
	}

	/** Start the preview job of a feature on `wolf`; the loader shows until the status reports it. */
	async startPreview(client: GraduateClient, target: GraduateTarget, wolf: string): Promise<void> {
		const base = { wolf, title: target.title };
		const g = this.set(target.id, { phase: "previewing", ...base });
		let res: KbResult<{ kind: "preview" | "confirm" }>;
		try {
			res = await client.startPreview(wolf, target.id);
		} catch (e) {
			res = thrown(e);
		}
		if (!this.current(target.id, g)) return;
		if (!res.ok) {
			if (res.code === "busy") return this.adopt(client, target.id, base, GraduateStore.runningKind(res, "confirm"));
			return void this.fail(target.id, base, "preview", res);
		}
		// Defence: a job of the other kind came back, polling it as a preview would wait for an outcome that never comes.
		if (res.data.kind !== "preview") return this.adopt(client, target.id, base, res.data.kind);
		void this.poll(client, target.id, wolf, g);
	}

	/** Send the reviewed preview: the confirm job runs in the background and the loader shows again. */
	async confirm(client: GraduateClient, id: string): Promise<void> {
		const cur = this.jobs.get(id);
		if (cur?.phase !== "ready") return;
		const { wolf, title, preview } = cur;
		const base = { wolf, title, preview };
		const g = this.set(id, { phase: "graduating", ...base });
		let res: KbResult<{ kind: "preview" | "confirm" }>;
		try {
			res = await client.startConfirm(wolf, id, preview.token);
		} catch (e) {
			res = thrown(e);
		}
		if (!this.current(id, g)) return;
		if (!res.ok) {
			if (res.code === "busy") return this.adopt(client, id, base, GraduateStore.runningKind(res, "preview"));
			return void this.fail(id, base, "confirm", res);
		}
		if (res.data.kind !== "confirm") return this.adopt(client, id, base, res.data.kind);
		void this.poll(client, id, wolf, g);
	}

	/**
	 * The owner retries after an error. Returns where to go: "graduate" (the confirmation step: the preview is gone or
	 * stale) or "review" (the preview is still good: the confirm failed, nothing was archived).
	 */
	retry(id: string): "graduate" | "review" {
		const cur = this.jobs.get(id);
		if (cur?.phase === "error" && cur.during === "confirm" && cur.preview && cur.code !== "preview_stale") {
			this.set(id, { phase: "ready", wolf: cur.wolf, title: cur.title, preview: cur.preview, lastError: { kind: "confirm", ...(cur.code ? { code: cur.code } : {}), message: cur.message } });
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
		const epoch = this.epoch;
		const stale = () => epoch !== this.epoch || this.jobs.has(id);
		this.recovering.add(id);
		try {
			const choice = graduationWolf(target.assignee, await this.wolves(client));
			if (epoch !== this.epoch || choice.kind !== "assignee") return;
			const res = await client.status(choice.wolf, id);
			if (!res.ok || stale()) return;
			const s = res.data;
			// Only a ready preview and a running job are picked up. `graduated` (the list refresh shows the archived feature) and
			// `error` (the owner never saw this attempt) are deliberately ignored: showing a stale error or toast on page load would confuse.
			if (s.state === "preview_ready") this.set(id, { phase: "ready", wolf: choice.wolf, title: target.title, preview: s.preview, ...(s.lastError ? { lastError: s.lastError } : {}) });
			else if (s.state === "running") {
				const g = this.set(id, s.kind === "preview" ? { phase: "previewing", wolf: choice.wolf, title: target.title } : { phase: "graduating", wolf: choice.wolf, title: target.title });
				void this.poll(client, id, choice.wolf, g);
			}
		} catch {
			// recovery is best effort: the button just stays as it was
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

	private fail(id: string, base: { wolf: string; title: string; preview?: GraduationPreview }, during: "preview" | "confirm", res: Failure): void {
		this.set(id, { phase: "error", wolf: base.wolf, title: base.title, during, message: res.message, ...(res.code ? { code: res.code } : {}), ...(base.preview ? { preview: base.preview } : {}) });
	}

	/**
	 * Poll the status until the phase can advance. Every state the wolf answers moves the phase or ends the loop except
	 * `running`, which is bounded by the deadline; unreadable answers end it after MAX_READ_FAILURES in a row.
	 */
	private async poll(client: GraduateClient, id: string, wolf: string, g: number): Promise<void> {
		let failures = 0;
		const until = Date.now() + this.deadlineMs;
		for (;;) {
			let res: KbResult<GraduationStatus>;
			try {
				res = await client.status(wolf, id);
			} catch (e) {
				res = thrown(e);
			}
			if (!this.current(id, g)) return;
			const cur = this.jobs.get(id);
			if (!cur || (cur.phase !== "previewing" && cur.phase !== "graduating")) return;
			const during = cur.phase === "previewing" ? "preview" : "confirm";
			if (!res.ok) {
				if (++failures >= MAX_READ_FAILURES) return void this.fail(id, cur, during, res);
			} else {
				failures = 0;
				const s = res.data;
				if (s.state === "preview_ready") {
					// While previewing, the job we waited for; while graduating, a confirm that failed and left its preview valid.
					this.set(id, { phase: "ready", wolf, title: cur.title, preview: s.preview, ...(s.lastError ? { lastError: s.lastError } : {}) });
					return;
				}
				if (s.state === "graduated") {
					this.set(id, undefined);
					this.done = [...this.done.filter((d) => d.id !== id), { id, title: cur.title, wolf, result: s.result }];
					this.emit();
					notifyGraduated(id);
					return;
				}
				if (s.state === "error") return void this.fail(id, cur, s.kind, { ok: false, reason: "error", message: s.message, code: s.code });
				if (s.state === "none") return void this.fail(id, cur, during, { ok: false, reason: "error", message: `${wolf} lost the graduation job (it restarted?). Try again.` });
			}
			if (Date.now() >= until) return void this.fail(id, cur, during, { ok: false, reason: "error", message: `${wolf} did not finish within ${Math.round(this.deadlineMs / 60000)} minutes. Try again.` });
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
