import { GraphHome } from "@/components/graph-home";

/**
 * The graph is the ALWAYS-ON background layer: it lives in this layout, so moving between "/" and /kb/entry/[id]
 * never unmounts it. The reader (the route's page) draws as an overlay on top; closing it returns to "/" with the
 * graph untouched. The Work list is an overlay too (WorkViewProvider in the root layout), independent of the route.
 */
export default function HomeLayout({ children }: { children: React.ReactNode }) {
	return (
		<>
			<GraphHome />
			{children}
		</>
	);
}
