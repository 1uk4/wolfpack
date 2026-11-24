import { redirect } from "next/navigation";

/** /prompts: the prompts graph lives under the wolf's page in the Pack, so this goes to the Wolves section. */
export default function Page(): never {
	redirect("/pack/wolves");
}
