import { redirect } from "next/navigation";

/** "/pack" goes to the first section. */
export default function Page(): never {
	redirect("/pack/machines");
}
