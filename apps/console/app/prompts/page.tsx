import { Suspense } from "react";
import { PromptsView } from "@/components/prompts-view";

export const dynamic = "force-dynamic";

export default function PromptsPage() {
	return (
		<Suspense fallback={null}>
			<PromptsView />
		</Suspense>
	);
}
