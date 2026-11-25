import { Suspense } from "react";
import { redirect } from "next/navigation";
import { PackPage } from "@/components/pack/pack-page";
import { parseWolfPath } from "@/src/core/pack/wolf-path";

export const dynamic = "force-dynamic";

/** "/pack/wolves/<hostId>/<name>[/<tab>]": a wolf's page inside the Pack's Wolves section (work-wolfpack-iafGCfG). /pack/wolves itself is the list ([section]). */
export default async function Page({ params }: { params: Promise<{ rest: string[] }> }) {
	const { rest } = await params;
	if (!parseWolfPath(`/pack/wolves/${rest.join("/")}`)) redirect("/pack/wolves");
	return (
		<Suspense fallback={null}>
			<PackPage section="wolves" />
		</Suspense>
	);
}
