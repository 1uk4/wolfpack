import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import "katex/dist/katex.min.css";
import "@xyflow/react/dist/style.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/shell/sidebar";
import { SubagentModalProvider } from "@/components/thread/subagent-modal";
import { GraduateToasts } from "@/components/kb/graduate-dialog";
import { ServerEventsProvider } from "@/components/shell/server-events";
import { MemoryEventsProvider } from "@/components/memory/memory-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import { AttachedThreadProvider } from "@/components/chat-bar/attached-thread";
import { NavTracker } from "@/components/shell/nav-tracker";
import HubAuth from "@/components/shell/hub-auth";
import UpdateBanner from "@/components/shell/update-banner";
import { SingleMacProvider } from "@/components/shell/single-mac";
import { isSingleMac } from "@/src/core/single-mac";
import { ViewportVars } from "@/components/shell/viewport-vars";

// Chrome, prose and titles = Inter; code = Geist Mono.
const ui = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });
const prose = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
	title: "Wolfpack Console",
	description: "The control plane for wolfpack agents.",
	// manifest.webmanifest is emitted from app/manifest.ts; iOS ignores manifest icons, so the touch icon is explicit.
	// An explicit `icons` object stops Next adding the app/icon.png file-convention link, so the favicon is listed here too.
	icons: { icon: { url: "/icon.png", type: "image/png", sizes: "64x64" }, apple: "/icons/apple-touch-icon.png" },
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

export const dynamic = "force-dynamic"; // the single-Mac flag is read at runtime, never baked into the build

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className={`dark ${ui.variable} ${prose.variable}`}>
			<body className="min-h-dvh antialiased">
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<SingleMacProvider value={isSingleMac()}>
			<HubAuth />
			<ViewportVars />
			<NavTracker />
			<ServerEventsProvider>
				<MemoryEventsProvider>
					<AppearanceProvider>
						<SidebarProvider>
								<SubagentModalProvider>
									<AttachedThreadProvider>
										<AppShell>{children}</AppShell>
									</AttachedThreadProvider>
									<GraduateToasts />
								</SubagentModalProvider>
						</SidebarProvider>
					</AppearanceProvider>
				</MemoryEventsProvider>
			</ServerEventsProvider>
			{/* Auto-update banner (Wave C): fixed card, Electron-only pushes. */}
			<UpdateBanner />
			</SingleMacProvider>
		</body>
		</html>
	);
}
