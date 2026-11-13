import { EntryReaderPage } from "@/components/kb/entry-reader";

/** A KB entry as its own page (no graph behind it). Same URL the old overlay used, so existing links and reloads keep working. */
export default async function KbEntryPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return <EntryReaderPage id={decodeURIComponent(id)} />;
}
