"use client";
import { SidebarToggle } from "@/components/sidebar";
export function TopBar({ drag = true, onMouseDown, children, }) {
    return (<header onMouseDown={onMouseDown} className={`${drag ? "lh-drag " : ""}lh-wco-gutter flex h-15 select-none items-center gap-3 border-b border-border px-3`}>
			<SidebarToggle />
			{children}
		</header>);
}
//# sourceMappingURL=top-bar.js.map