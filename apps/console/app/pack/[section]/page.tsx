import { Suspense } from "react";
import { redirect } from "next/navigation";
import { PackPage } from "@/components/pack/pack-page";
import { PACK_SECTIONS } from "@/src/core";

export const dynamic = "force-dynamic"; // like the other data pages: the production build refuses unexpected prerendered routes

/** "/pack/<section>": the Pack as a full page. An unknown section goes to Machines (the desktop app's hidden ones are handled in the page). */
export default async function Page({ params }: { params: Promise<{ section: string }> }) {
	const { section } = await params;
	const known = PACK_SECTIONS.find((s) => s.id === section);
	if (!known) redirect("/pack/machines");
	return (
		<Suspense fallback={null}>
			<PackPage section={known.id} />
		</Suspense>
	);
}
