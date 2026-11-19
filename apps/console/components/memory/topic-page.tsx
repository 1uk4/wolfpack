"use client";

/** A session topic as its own page (/wolf/<wolf>/memory/topic/<id>): frontmatter block, markdown body, Promote and Keep local. */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { KbMarkdown } from "@/components/kb/kb-markdown";
import { fetchMemoryTopic, fetchSessionTopics, postPromote, putKeepLocal } from "@/components/kb/kb-client";
import { TopBar } from "@/components/shell/top-bar";
import { topicChip, topicFacts, type MemoryTopicRow } from "@/src/core";

const LABEL = "font-mono text-[11px] uppercase tracking-wide text-muted-foreground";

/** The frontmatter block: state chip (reason as tooltip) and the facts; KB entry ids link to their pages. */
export function TopicFacts({ topic }: { topic: MemoryTopicRow }) {
	const chip = topicChip(topic);
	return (
		<dl className="mb-6 flex flex-wrap gap-x-6 gap-y-2 text-sm" data-testid="topic-facts">
			{topicFacts(topic).map((f) => (
				<div key={f.key} data-fact={f.key} className="min-w-0 max-w-full">
					<dt className={LABEL}>{f.key}</dt>
					<dd className="break-words">
						{f.key === "state" && chip ? (
							<span title={chip.title} className={`rounded-full px-1.5 text-xs ${chip.tone === "warn" ? "bg-amber-50 text-amber-700" : "bg-muted text-muted-foreground"}`} data-testid="topic-chip">{chip.label}</span>
						) : f.entryIds ? (
							f.entryIds.map((id, i) => (
								<span key={id}>
									{i > 0 && ", "}
									<Link href={`/kb/entry/${encodeURIComponent(id)}`} className="underline underline-offset-2">{id}</Link>
								</span>
							))
						) : (
							f.value
						)}
					</dd>
				</div>
			))}
		</dl>
	);
}

export function TopicPage({ wolf, id }: { wolf: string; id: string }) {
	const [row, setRow] = useState<MemoryTopicRow | null>(null);
	const [body, setBody] = useState<string | null>(null);
	const [title, setTitle] = useState(id);
	const [error, setError] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);

	const load = useCallback(async () => {
		const [list, topic] = await Promise.all([fetchSessionTopics(wolf), fetchMemoryTopic(wolf, id, "session")]);
		if (list.ok && Array.isArray(list.data?.topics)) {
			setRow([...list.data.topics, ...(list.data.retired ?? [])].find((t) => t.id === id) ?? null);
		}
		if (topic.ok) { setBody(topic.data.body); setTitle(topic.data.title); setError(null); }
		else setError(topic.message);
	}, [wolf, id]);
	useEffect(() => { void load(); }, [load]);

	const toggleKeep = async () => {
		if (!row) return;
		const r = await putKeepLocal(wolf, id, !row.keepLocal);
		if (!r.ok) setNote(r.message);
		await load();
	};
	const promote = async () => {
		const r = await postPromote(wolf, [id]);
		setNote(r.ok ? "Promote started." : r.message);
		await load();
	};

	return (
		<div className="flex h-dvh flex-col" data-testid="topic-page" data-topic={id}>
			<TopBar>
				<h1 className="min-w-0 truncate font-title text-2xl tracking-tight md:text-3xl">{title}</h1>
				<Link href={`/wolf/${encodeURIComponent(wolf)}`} className="ml-auto flex shrink-0 items-center text-xs text-muted-foreground underline underline-offset-2 max-md:min-h-11 max-md:min-w-11 max-md:justify-center" data-testid="topic-back">
					Back to thread
				</Link>
			</TopBar>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto min-w-0 max-w-3xl px-4 py-6 md:px-6 md:py-8">
					{error && <p className="text-sm text-destructive" role="alert">Could not load this topic: {error}</p>}
					{!error && body === null && <p className="text-sm text-muted-foreground">Loading…</p>}
					{row && <TopicFacts topic={row} />}
					{row && (
						<div className="mb-6 flex flex-wrap items-center gap-2" data-testid="topic-actions">
							<Button size="sm" onClick={() => void promote()}>Promote</Button>
							<Button size="sm" variant="outline" aria-pressed={row.keepLocal} onClick={() => void toggleKeep()}>
								{row.keepLocal ? "Keep local: on" : "Keep local"}
							</Button>
							{note && <span className="text-xs text-muted-foreground" data-testid="topic-note">{note}</span>}
						</div>
					)}
					{body !== null && (
						<div className="min-w-0 break-words text-sm">
							<KbMarkdown>{body}</KbMarkdown>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
