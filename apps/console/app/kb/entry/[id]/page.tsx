import { EntryReader } from "@/components/entry-reader";

export default async function KbEntryPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return <EntryReader id={decodeURIComponent(id)} />;
}
