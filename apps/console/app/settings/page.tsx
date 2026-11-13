import { redirect } from "next/navigation";

/** /settings used to open the Settings dialog on Wolf settings; the Pack's Wolves section holds that now (work-wolfpack-u6GH2kk). */
export default function Page(): never {
	redirect("/?pack=wolves");
}
