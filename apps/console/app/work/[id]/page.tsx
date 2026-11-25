import { notFound } from "next/navigation";
import { Suspense } from "react";
import { WorkItemPage } from "@/components/work/work-item-page";

export const dynamic = "force-dynamic";

/** "/work/<id>": the work item page (the batch graduation card links here with ?view=graduation&wolf=<name>). */
export default async function WorkItemRoute({ params }: { params: Promise<{ id: string }> }) {
	const { id: raw } = await params;
	let id: string;
	try {
		id = decodeURIComponent(raw);
	} catch {
		notFound(); // a malformed escape (/work/%E0%A4%A) is not an item
	}
	return (
		<Suspense fallback={null}>
			<WorkItemPage id={id} />
		</Suspense>
	);
}
