import { redirect } from "next/navigation";

/** /settings used to open the Settings dialog on Wolf settings; the Pack page's Wolves section holds that now. */
export default function Page(): never {
	redirect("/pack/wolves");
}
