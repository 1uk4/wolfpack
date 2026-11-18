"use client";

/** The sidebar nav's Work link: a plain link to the Work page (/work), the sibling of the Graph link. */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ListTreeIcon } from "lucide-react";
import { useSidebar } from "@/components/shell/sidebar";
import { cn } from "@/lib/utils";

export function WorkNavEntry() {
	const { closeList } = useSidebar();
	const pathname = usePathname();
	const here = pathname === "/work";
	return (
		<Link
			href="/work"
			onClick={closeList}
			data-testid="nav-work"
			aria-current={here ? "page" : undefined}
			className={cn(
				"flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider transition-colors hover:bg-accent hover:text-foreground",
				here ? "bg-accent text-foreground" : "text-muted-foreground",
			)}
		>
			<ListTreeIcon className="size-3" />
			Work
		</Link>
	);
}
