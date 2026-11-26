/**
 * OWNER PRESENCE CONTROLLER (pure; timers and the sender are injected so it tests without a DOM). work-wolfpack-BPwZ7wf.
 * Publishes the owner's current target: one send per target change (debounced), a heartbeat while the tab is active
 * (visible AND focused) on the same target, nothing while hidden. `send` is fire and forget; a throwing sender is swallowed.
 */
export interface PresenceTarget {
	kind: "thread" | "work-item" | "kb-entry";
	id: string;
	title?: string;
	domain?: string;
}

export const PRESENCE_DEBOUNCE_MS = 1000;
export const PRESENCE_HEARTBEAT_MS = 60_000;
export const PRESENCE_TTL_MS = 120_000;

export interface Scheduler {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(h: unknown): void;
	setInterval(fn: () => void, ms: number): unknown;
	clearInterval(h: unknown): void;
}

const same = (a: PresenceTarget | null, b: PresenceTarget | null) => a === b || (!!a && !!b && a.kind === b.kind && a.id === b.id && a.title === b.title && a.domain === b.domain);

export function createPresenceController(o: { send: (t: PresenceTarget) => void; sched?: Scheduler; debounceMs?: number; heartbeatMs?: number }) {
	const sched: Scheduler = o.sched ?? {
		setTimeout: (f, ms) => setTimeout(f, ms),
		clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
		setInterval: (f, ms) => setInterval(f, ms),
		clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
	};
	let target: PresenceTarget | null = null;
	let active = true;
	let pending = false; // a change not yet sent
	let debounce: unknown;
	let beat: unknown;

	const fire = () => {
		debounce = undefined;
		if (!target || !active) return; // stays pending until the tab is active again
		pending = false;
		try {
			o.send(target);
		} catch {
			/* fire and forget */
		}
	};
	const stopBeat = () => {
		if (beat !== undefined) sched.clearInterval(beat);
		beat = undefined;
	};
	const startBeat = () => {
		stopBeat();
		if (!target || !active) return;
		beat = sched.setInterval(() => {
			if (!target || !active) return;
			try {
				o.send(target);
			} catch {
				/* fire and forget */
			}
		}, o.heartbeatMs ?? PRESENCE_HEARTBEAT_MS);
	};
	const schedule = () => {
		if (debounce !== undefined) sched.clearTimeout(debounce);
		debounce = sched.setTimeout(fire, o.debounceMs ?? PRESENCE_DEBOUNCE_MS);
	};

	return {
		setTarget(t: PresenceTarget | null) {
			if (same(t, target)) return;
			target = t;
			if (debounce !== undefined) sched.clearTimeout(debounce);
			debounce = undefined;
			pending = !!t;
			stopBeat();
			if (t) {
				schedule();
				startBeat();
			}
		},
		/** active = tab visible and focused. Hidden stops the heartbeat; coming back sends a fresh beat for a pending or current target. */
		setActive(next: boolean) {
			if (next === active) return;
			active = next;
			if (!next) {
				stopBeat();
				return;
			}
			if (target) {
				pending = true;
				schedule();
				startBeat();
			}
		},
		dispose() {
			if (debounce !== undefined) sched.clearTimeout(debounce);
			debounce = undefined;
			stopBeat();
			target = null;
			pending = false;
		},
		/** For tests: whether a change is still waiting to be sent. */
		isPending: () => pending,
	};
}

/** The page's own target from its pathname (thread, work item and KB entry pages). Null elsewhere. */
export function targetFromPath(pathname: string): PresenceTarget | null {
	const seg = pathname.split("/").filter(Boolean).map((s) => {
		try {
			return decodeURIComponent(s);
		} catch {
			return s;
		}
	});
	// The protocol target has no wolf field: a thread id travels as `<wolf>/<slug>` so two wolves with the same slug stay apart.
	if (seg[0] === "wolf" && seg[1] && seg[2] === "thread" && seg[3]) return { kind: "thread", id: `${seg[1]}/${seg[3]}` };
	if (seg[0] === "work" && seg[1]) return { kind: "work-item", id: seg[1] };
	if (seg[0] === "kb" && seg[1] === "entry" && seg[2]) return { kind: "kb-entry", id: seg[2] };
	if (seg[0] === "kb" && seg[1] === "work" && seg[2]) return { kind: "work-item", id: seg[2] };
	return null;
}

/** A viewer-panel view as a target (kinds "work" and "kb"); other kinds (prompt, frame) are not reported. */
export function targetFromView(v: { kind: string; id: string; title?: string } | null): PresenceTarget | null {
	if (!v) return null;
	const kind = v.kind === "work" ? "work-item" : v.kind === "kb" ? "kb-entry" : null;
	return kind ? { kind, id: v.id, ...(v.title ? { title: v.title } : {}) } : null;
}
