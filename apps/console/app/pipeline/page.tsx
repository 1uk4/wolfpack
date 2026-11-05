import { redirect } from "next/navigation";

/** The Dewey pipeline page is retired: /pipeline now lands on the hub-served KB activity page. */
export default function PipelinePage(): never {
	redirect("/kb-activity");
}
