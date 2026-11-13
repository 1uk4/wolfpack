import { GraphHome } from "@/components/graph/graph-home";

export const dynamic = "force-dynamic"; // like the other data pages: the production build refuses unexpected prerendered routes

/** "/graph": the pack's knowledge graph (it was the home page until "/" became the light wolf list). The work reader (`?item=<id>`) is mounted once in AppShell. */
export default function GraphPage() {
	return <GraphHome />;
}
