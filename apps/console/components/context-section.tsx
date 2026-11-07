"use client";

import { useCallback, useEffect, useState } from "react";
import { BrailleSpinner } from "@/components/braille-spinner";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { ContextBar, contextLabel, pastStartAt, useThreadContext } from "@/components/thread-context";
import { CompactionThresholdRow } from "@/components/settings/agent-section";
import { CURRENT_SETTINGS_VERSION, type CompactionSettings, type UserSettings } from "@/src/core";

/** The compaction settings, edited inline: the same record Settings → Agent edits (GET /api/settings, PUT /api/settings/compaction). */
function CompactionSettingsEditor() {
	const [compaction, setCompaction] = useState<CompactionSettings | undefined>();
	const [error, setError] = useState<string | null>(null);
	const load = useCallback(() => {
		fetch("/api/settings")
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
			.then((body: { settings: UserSettings | null }) => setCompaction((body.settings ?? { version: CURRENT_SETTINGS_VERSION }).compaction))
			.catch(() => setError("Compaction settings unavailable"));
	}, []);
	useEffect(load, [load]);
	useSettingsSaved((section) => section === "compaction" && load());
	const write = async (next: CompactionSettings) => {
		setError(null);
		const res = await fetch("/api/settings/compaction", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
		if (!res.ok) {
			const detail = (await res.json().catch(() => ({}))) as { error?: string };
			setError(`compaction: ${detail.error ?? res.status}`);
			return;
		}
		const stored = ((await res.json().catch(() => null)) as { settings?: UserSettings } | null)?.settings;
		setCompaction(stored ? stored.compaction : next);
		notifySettingsSaved("compaction");
	};
	return (
		<div data-testid="context-settings">
			<CompactionThresholdRow compaction={compaction} onChange={(next) => void write(next)} />
			{error ? <p role="alert" className="text-xs text-destructive" data-testid="context-settings-error">{error}</p> : null}
		</div>
	);
}

/** The Memory panel's Context section: live context for the thread (tokens against the window, compactions, Compact) and the compaction settings. */
export function ContextSection({ wolf, slug, threadId }: { wolf: string; slug: string; threadId: string }) {
	const { ctx, compacting, error, compact } = useThreadContext(wolf, slug, threadId);
	return (
		<section data-testid="context-section">
			<h3 className="mb-1 text-xs font-medium uppercase text-muted-foreground">Context</h3>
			{ctx ? (
				<div className="flex flex-col gap-1.5">
					<ContextBar c={ctx} />
					<p className={`font-mono text-xs ${pastStartAt(ctx) ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`} data-testid="context-section-label">{contextLabel(ctx)}</p>
					{error ? <p role="alert" className="text-xs text-destructive" data-testid="context-error">{error}</p> : null}
					<button
						type="button"
						data-testid="context-compact"
						disabled={compacting}
						onClick={() => void compact()}
						className="flex items-center justify-center gap-1.5 self-start rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-60"
					>
						{compacting ? (
							<>
								<BrailleSpinner label="Summarising" className="h-3" />
								Summarising…
							</>
						) : (
							"Compact"
						)}
					</button>
				</div>
			) : (
				<p className="text-xs text-muted-foreground">Loading…</p>
			)}
			<CompactionSettingsEditor />
		</section>
	);
}
