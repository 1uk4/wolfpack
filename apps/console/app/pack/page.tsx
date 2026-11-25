import { redirect } from "next/navigation";

/** "/pack" goes to the first section. */
export default function Page(): never {
	redirect("/pack/machines");
}

export const dynamic = "force-dynamic"; // like [section]: the production build refuses unexpected prerendered routes
