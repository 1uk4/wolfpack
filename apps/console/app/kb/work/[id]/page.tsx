import { WorkItemPage } from "@/components/work-item-page";

export default async function KbWorkPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return <WorkItemPage id={decodeURIComponent(id)} />;
}
