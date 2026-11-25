/** A bare Next app-router context (no history): enough for components that call useRouter / usePathname / useSearchParams during render. */
import React, { type ReactNode } from "react";

const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { PathnameContext, SearchParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");

const router = { push() {}, replace() {}, back() {}, forward() {}, prefetch() {}, refresh() {} };
const params = new URLSearchParams();

export function RouterStub({ children, search = "", path = "/pack" }: { children: ReactNode; search?: string; path?: string }) {
	return (
		<AppRouterContext.Provider value={router as never}>
			<PathnameContext.Provider value={path}>
				<SearchParamsContext.Provider value={(search ? new URLSearchParams(search) : params) as never}>{children}</SearchParamsContext.Provider>
			</PathnameContext.Provider>
		</AppRouterContext.Provider>
	);
}
