import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import "katex/dist/katex.min.css";
import "@xyflow/react/dist/style.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { SubagentModalProvider } from "@/components/subagent-modal";
import { GraduateToasts } from "@/components/graduate-dialog";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { MemoryEventsProvider } from "@/components/memory-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import { AttachedThreadProvider } from "@/components/attached-thread";
import { NavTracker } from "@/components/nav-tracker";
import HubAuth from "@/components/hub-auth";
import UpdateBanner from "@/components/update-banner";
import { ViewportVars } from "@/components/viewport-vars";

// Chrome = Geist Mono, prose = Inter, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN).
const ui = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });
const prose = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
	title: "Wolfpack Console",
	description: "The control plane for wolfpack agents.",
	// manifest.webmanifest is emitted from app/manifest.ts; iOS ignores manifest icons, so the touch icon is explicit.
	icons: { apple: "/icons/apple-touch-icon.png" },
	appleWebApp: { capable: true, title: "Wolfpack", statusBarStyle: "black-translucent" },
};

// maximumScale/userScalable: fixed in place like an iOS app (no pinch or double-tap zoom; globals.css adds touch-action for iOS Safari, which ignores these).
// viewportFit=cover: env(safe-area-inset-*) works (iOS notch/home bar). interactiveWidget: Android keyboards resize the layout.
export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	maximumScale: 1,
	userScalable: false,
	viewportFit: "cover",
	themeColor: "#0f141a",
	interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className={`dark ${ui.variable} ${prose.variable}`}>
			<body className="min-h-dvh antialiased">
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<HubAuth />
			<ViewportVars />
			<NavTracker />
			<ServerEventsProvider>
				<MemoryEventsProvider>
					<AppearanceProvider>
						<SidebarProvider>
							<ActivityProvider>
								<SubagentModalProvider>
									<AttachedThreadProvider>
										<AppShell>{children}</AppShell>
									</AttachedThreadProvider>
									<GraduateToasts />
								</SubagentModalProvider>
							</ActivityProvider>
						</SidebarProvider>
					</AppearanceProvider>
				</MemoryEventsProvider>
			</ServerEventsProvider>
			{/* Auto-update banner (Wave C): fixed card, Electron-only pushes. */}
			<UpdateBanner />
		</body>
		</html>
	);
}
