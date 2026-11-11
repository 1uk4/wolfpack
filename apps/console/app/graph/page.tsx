import { GraphHome } from "@/components/graph-home";

/** "/graph": the pack's knowledge graph (it was the home page until "/" became the light wolf list). The work reader (`?item=<id>`) is mounted once in AppShell. */
export default function GraphPage() {
	return <GraphHome />;
}
