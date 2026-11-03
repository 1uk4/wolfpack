import { Suspense } from "react";
import { WorkList } from "@/components/work-view";
import { WorkReaderHost } from "@/components/work-reader";

/**
 * "/work": the Work list on its own page (no graph behind it). `?item=<id>` opens the reader panel over it.
 * The list reads the search params (useSearchParams), so it sits in a Suspense boundary for the prerender.
 */
export default function WorkPage() {
	return (
		<>
			<Suspense fallback={null}>
				<WorkList />
			</Suspense>
			<WorkReaderHost />
		</>
	);
}
