import { TopicPage } from "@/components/memory/topic-page";

/** A session topic with its body, metadata and actions. */
export default async function MemoryTopicPage({ params }: { params: Promise<{ name: string; id: string }> }) {
	const { name, id } = await params;
	return <TopicPage wolf={decodeURIComponent(name)} id={decodeURIComponent(id)} />;
}
