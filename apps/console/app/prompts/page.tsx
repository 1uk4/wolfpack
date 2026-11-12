import { redirect } from "next/navigation";

/** /prompts used to open the Settings dialog on Prompts; prompts are viewed in the Pack's Wolves section now (work-wolfpack-u6GH2kk). */
export default function Page(): never {
	redirect("/?pack=wolves");
}
