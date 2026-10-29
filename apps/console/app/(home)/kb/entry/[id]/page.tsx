import { EntryReaderOverlay } from "@/components/entry-reader";

export default async function KbEntryPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return <EntryReaderOverlay id={decodeURIComponent(id)} />;
}
