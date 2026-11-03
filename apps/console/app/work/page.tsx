import { WorkList } from "@/components/work-view";
import { WorkReaderHost } from "@/components/work-reader";

/** "/work": the Work list on its own page (no graph behind it). `?item=<id>` opens the reader panel over it. */
export default function WorkPage() {
	return (
		<>
			<WorkList />
			<WorkReaderHost />
		</>
	);
}
