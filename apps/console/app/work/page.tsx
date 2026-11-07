import { Suspense } from "react";
import { WorkList } from "@/components/work-view";

export const dynamic = "force-dynamic"; // like the other data pages: the production build refuses unexpected prerendered routes

/**
 * "/work": the Work list on its own page (no graph behind it). `?item=<id>` opens the reader (mounted once in AppShell) over it.
 * The list reads the search params (useSearchParams), so it sits in a Suspense boundary for the prerender.
 */
export default function WorkPage() {
	return (
		<>
			<Suspense fallback={null}>
				<WorkList />
			</Suspense>
		</>
	);
}
