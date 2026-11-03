import { WorkReaderHost } from "@/components/work-reader";

/** "/": the graph itself is drawn by the (home) layout, so it stays mounted under the reader. `?item=<id>` opens a work item over it. */
export default function HomePage() {
	return <WorkReaderHost />;
}
