import { redirect } from "next/navigation";

/** The Dewey pipeline page is retired: /pipeline now lands on the graph. */
export default function PipelinePage(): never {
	redirect("/graph");
}
