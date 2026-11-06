import { GraphHome } from "@/components/graph-home";

/**
 * The graph is the ALWAYS-ON background layer: it lives in this layout, so moving between "/" and the work reader
 * never unmounts it. The work reader draws as an overlay on top; closing it returns to "/" with the
 * graph untouched. The Work list is NOT here: it is its own page (/work).
 */
export default function HomeLayout({ children }: { children: React.ReactNode }) {
	return (
		<>
			<GraphHome />
			{children}
		</>
	);
}
