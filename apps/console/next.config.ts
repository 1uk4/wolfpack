import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	// Self-contained server in .next/standalone, which the desktop shell spawns.
	// scripts/build-server.mjs copies public/ and .next/static next to it.
	output: "standalone",

	// No framing on any route: the console acts with the paired browser's hub token.
	// tests/next-config.test.ts pins both headers.
	async headers() {
		return [
			{
				source: "/:path*",
				headers: [
					{ key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
					{ key: "X-Frame-Options", value: "DENY" },
				],
			},
		];
	},

	// Keep local data and secrets out of the traced standalone bundle. Only these
	// three patterns are safe: broader directory excludes (such as "dist/**/*")
	// stripped the external pi packages from the trace and broke the packaged server.
	// scripts/build-server.mjs also refuses to package a bundle that holds auth.json.
	outputFileTracingExcludes: {
		"*": ["data/**/*", "auth.json", ".env*"],
	},

	// The tracer misses JSON loaded with `import ... with { type: "json" }`, so
	// include the data of the engine packages that are loaded at runtime.
	outputFileTracingIncludes: {
		"*": [
			"node_modules/@earendil-works/pi-ai/dist/providers/data/**/*",
			"node_modules/@earendil-works/pi-agent-core/dist/**/*.json",
		],
	},

	// The pi engine loads provider code at runtime; bundling it into routes breaks it.
	serverExternalPackages: ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core"],
};

export default nextConfig;
