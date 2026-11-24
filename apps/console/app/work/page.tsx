import { Suspense } from "react";
import { WorkList } from "@/components/work/work-view";
import { PageViewer } from "@/components/viewer/page-viewer";

export const dynamic = "force-dynamic"; // like the other data pages: the production build refuses unexpected prerendered routes

/**
 * "/work": the Work list on its own page (no graph behind it), inside a page viewer (scope "work", kinds work + kb):
 * a click on an item opens it in the viewer panel; modified clicks and direct URLs go to the full page (/kb/work/<id>).
 * The list reads the search params (useSearchParams), so it sits in a Suspense boundary for the prerender.
 */
export default function WorkPage() {
	return (
		<PageViewer scope="work" allowedKinds={["work", "kb"]}>
			<Suspense fallback={null}>
				<WorkList />
			</Suspense>
		</PageViewer>
	);
}
