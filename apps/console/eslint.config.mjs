import { defineConfig, globalIgnores } from "eslint/config";
import nextPlugin from "@next/eslint-plugin-next";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";

// Layering rules only (see docs/architecture.md); this is not a style linter.
//   components/  -> only the "@/src/core" barrel
//   app/         -> only the "@/src/core" and "@/src/server" barrels
//   src/core/    -> never agent, server or store
//   src/agent/   -> never server or store
const layer = (target, from, message, except) => ({ target, from, message, ...(except ? { except } : {}) });

export default defineConfig([
	globalIgnores([".next/**", "node_modules/**", "data/**", "next-env.d.ts", "scripts/**", "electron/**", "dist/**"]),
	{
		files: ["**/*.{js,mjs,ts,tsx}"],
		languageOptions: {
			parser: tsParser,
			parserOptions: { ecmaVersion: "latest", sourceType: "module" },
		},
		plugins: { "@next/next": nextPlugin, import: importPlugin },
		settings: { "import/resolver": { typescript: { alwaysTryTypes: true } } },
		rules: {
			...nextPlugin.configs.recommended.rules,
			"import/no-restricted-paths": [
				"error",
				{
					zones: [
						layer("./components", "./src", "components/ may import only the core barrel: @/src/core.", ["./core/index.ts"]),
						layer("./app", "./src", "app/ may import only the barrels @/src/core and @/src/server.", [
							"./core/index.ts",
							"./server/index.ts",
						]),
						layer(
							"./src/core",
							["./src/agent", "./src/server", "./src/store"],
							"src/core is pure: it never imports agent, server or store.",
						),
						layer(
							"./src/agent",
							["./src/server", "./src/store"],
							"src/agent never imports server or store; dependencies are passed in.",
						),
					],
				},
			],
		},
	},
]);
