import type { MetadataRoute } from "next";

/** Installable-only PWA (Add to Home Screen). No service worker: current Chrome/Safari don't require one to install, and nothing
 *  here is cached offline (API and auth responses must never be). Colours = the console's #0f141a dark theme. */
export default function manifest(): MetadataRoute.Manifest {
	return {
		name: "Wolfpack Console",
		short_name: "Wolfpack",
		description: "The control plane for wolfpack agents.",
		start_url: "/",
		scope: "/",
		display: "standalone",
		background_color: "#0f141a",
		theme_color: "#0f141a",
		icons: [
			{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
			{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
			{ src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
		],
	};
}
