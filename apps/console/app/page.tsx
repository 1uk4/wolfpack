import { NewSession } from "@/components/new-session";
import { readSettingsRecord } from "@/src/server";
import { slotsConfigured } from "@/src/core";

// Dynamic: the configured state is server-rendered into the page (the
// setup CTA's truth on the first frame), and every navigation re-reads
// the record (dynamic routes aren't cached client-side).
export const dynamic = "force-dynamic";

/**
 * Home is the sessionless draft view — the same surface as "+ New session".
 * The graph view (components/graph-view.tsx) is intentionally unrouted for
 * now; it returns when the knowledge graph has a data source.
 */
export default function HomePage() {
	// First-run gate (model-slots wave): chats cannot start until the user
	// has picked all three slots — the draft shows the CTA while the raw
	// record's models section lacks any slot pin.
	return <NewSession initialConfigured={slotsConfigured(readSettingsRecord()?.models)} />;
}
