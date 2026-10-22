/**
 * Guarded bash extensions for subagents. Wrap the built-in bash tool with a
 * pre-flight check:
 *  - `safe_bash`: blocks a few catastrophic patterns (rm -rf /, sudo, mkfs...).
 *  - `guarded_bash`: read-only guard for investigator/scout-style agents; blocks
 *    writes, deletes and state changes, including inside ssh/bash -c/sudo/$(...)
 *    (see command-guard.ts).
 *
 * Loaded into a child pi process via `--extension` when an agent's `tools`
 * frontmatter lists either name. See getToolExtensionPath in ../index.ts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { checkReadOnlyCommand } from "./command-guard.ts";

const DANGEROUS_PATTERNS = [
	/\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?(\/|~\/?\s|~\/?\b)/,
	/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?(\/|~\/?\s|~\/?\b)/,
	/\bsudo\b/,
	/\bmkfs\b/,
	/\bdd\s+if=/,
	/:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
	/>\s*\/dev\/[sh]d[a-z]/,
	/\bchmod\s+(-[a-zA-Z]+\s+)?777\s+\//,
	/\bchown\s+(-[a-zA-Z]+\s+)?root/,
	/\bcurl\s.*\|\s*(ba)?sh/,
	/\bwget\s.*\|\s*(ba)?sh/,
	/\bshutdown\b/,
	/\breboot\b/,
	/\binit\s+0\b/,
	/\bkill\s+-9\s+1\b/,
	/\bkillall\b/,
];

function isDangerous(command: string): string | null {
	const normalized = command.replace(/\\\n/g, " ");
	for (const pattern of DANGEROUS_PATTERNS) {
		if (pattern.test(normalized)) {
			return `Command blocked by safe_bash: matches dangerous pattern ${pattern}`;
		}
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	const bashTool = createBashTool(process.cwd());

	const register = (
		name: string,
		label: string,
		description: string,
		check: (command: string) => string | null,
	) =>
		pi.registerTool({
			name,
			label,
			description,
			parameters: Type.Object({
				command: Type.String({ description: "Bash command to execute" }),
				timeout: Type.Optional(
					Type.Number({ description: "Timeout in seconds (optional)" }),
				),
			}),
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const danger = check(params.command);
				if (danger) {
					throw new Error(danger);
				}
				return bashTool.execute(toolCallId, params, signal, onUpdate);
			},
		});

	register(
		"safe_bash",
		"Safe Bash",
		"Execute a bash command. Blocks dangerous commands (rm -rf /, sudo, mkfs, etc.).",
		isDangerous,
	);
	register(
		"guarded_bash",
		"Guarded Bash",
		"Execute a read-only bash command. Writes, deletes, redirects to files (except /dev/null, and /tmp/ locally), service/package/git/network changes are blocked, including inside ssh '...', bash -c, sudo and $(...).",
		checkReadOnlyCommand,
	);
}
