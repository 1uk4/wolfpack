/**
 * Wolf Identity extension — provides system prompt sections for wolf identity.
 *
 * Reads AGENTS.md and CLAUDE.md from the wolf directories and injects them
 * as system prompt sections. Also provides wolf context (name, domains, role).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineExtension, section } from "@earendil-works/pi-durable";
/**
 * Create the wolf identity extension with the given config.
 */
export function createWolfIdentityExtension(options) {
    const { config, wolfDen } = options;
    const agentDir = options.agentDir ?? join(wolfDen, "..", "agent");
    return defineExtension({
        name: "wolf-identity",
        sections: [
            // Wolf identity section — dynamically generated from config
            section("wolf_identity", () => {
                const lines = [
                    `# ${config.name}`,
                    "",
                    `**Role:** ${config.role ?? config.name}`,
                    `**Model:** ${config.model}`,
                ];
                if (config.specialty) {
                    lines.push(`**Specialty:** ${config.specialty}`);
                }
                // Capabilities from extensions
                const capabilities = [];
                const exts = config.extensions ?? [];
                if (exts.includes("memory")) {
                    capabilities.push("Memory (persistent across sessions)");
                }
                if (exts.includes("subagents")) {
                    capabilities.push("Subagents (can spawn workers for parallel tasks)");
                }
                if (exts.includes("ask")) {
                    capabilities.push("Ask (can ask clarifying questions)");
                }
                if (config.telegram) {
                    capabilities.push("Telegram (messages, buttons, reactions, files)");
                }
                if (capabilities.length > 0) {
                    lines.push("", "**Capabilities:** " + capabilities.join(", "));
                }
                if (config.domains?.length) {
                    lines.push(`**Domains:** ${config.domains.join(", ")}`);
                }
                return lines.join("\n");
            }),
            // NOTES.md section — user custom instructions (optional)
            section("wolf_notes", async () => {
                try {
                    const notesPath = join(wolfDen, "NOTES.md");
                    return await readFile(notesPath, "utf-8");
                }
                catch {
                    return undefined; // No NOTES.md, skip section
                }
            }),
            // CLAUDE.md section — project-specific instructions
            section("claude_md", async () => {
                // Check both wolf den and agent dir for CLAUDE.md
                for (const dir of [wolfDen, agentDir]) {
                    try {
                        const claudePath = join(dir, "CLAUDE.md");
                        return await readFile(claudePath, "utf-8");
                    }
                    catch {
                        continue;
                    }
                }
                return undefined; // No CLAUDE.md found, skip section
            }),
            // telegram.md section — user-defined telegram interaction rules
            section("telegram_rules", async () => {
                try {
                    const telegramPath = join(wolfDen, "telegram.md");
                    const content = await readFile(telegramPath, "utf-8");
                    return `## Telegram Rules\n\n${content}`;
                }
                catch {
                    return undefined; // No telegram.md, skip section
                }
            }),
        ],
    });
}
//# sourceMappingURL=wolf-identity.js.map