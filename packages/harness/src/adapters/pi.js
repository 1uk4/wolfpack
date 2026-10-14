/**
 * Generate pi-coding-agent compatible extension code.
 *
 * This returns a string of code that can be written to a file and loaded by pi.
 * The generated code uses @earendil-works/pi-coding-agent APIs.
 */
export function generatePiExtensionCode(ext) {
    const lines = [
        `// Auto-generated pi-coding-agent wrapper for ${ext.name}`,
        `import { defineExtension, defineTool, section } from "@earendil-works/pi-coding-agent";`,
        `import { Type } from "@earendil-works/pi-ai";`,
        ``,
    ];
    // Generate tools
    const toolDefs = [];
    for (const tool of ext.tools ?? []) {
        toolDefs.push(`
    defineTool({
      name: "${tool.name}",
      description: ${JSON.stringify(tool.description)},
      parameters: ${schemaToCode(tool.parameters)},
      async execute(args, api) {
        const context = {
          cwd: api.cwd ?? process.cwd(),
          wolfDen: process.env.WOLF_DEN ?? "",
          wolfName: process.env.WOLF_NAME ?? "",
          conversationId: 1,
        };
        // Import and call the original execute function
        const ext = await import("./core.js");
        return ext.tools["${tool.name}"].execute(args, context);
      },
    })`);
    }
    // Generate sections
    const sectionDefs = [];
    for (const sec of ext.sections ?? []) {
        sectionDefs.push(`
    section("${sec.name}", () => {
      const context = {
        wolfDen: process.env.WOLF_DEN ?? "",
        wolfName: process.env.WOLF_NAME ?? "",
        conversationId: 1,
      };
      // Import and call the original render function
      const ext = await import("./core.js");
      return ext.sections["${sec.name}"].render(context);
    })`);
    }
    lines.push(`export default defineExtension({`);
    lines.push(`  name: "${ext.name}",`);
    if (toolDefs.length > 0) {
        lines.push(`  tools: [${toolDefs.join(",\n")}],`);
    }
    if (sectionDefs.length > 0) {
        lines.push(`  sections: [${sectionDefs.join(",\n")}],`);
    }
    lines.push(`});`);
    return lines.join("\n");
}
/**
 * Convert a TypeBox schema to code string.
 * This is a simplified version - extend as needed.
 */
function schemaToCode(schema) {
    // For now, just stringify. In practice, we'd need proper schema serialization.
    return `Type.Object(${JSON.stringify(schema)})`;
}
/**
 * Placeholder for direct adaptation (if we ever run pi extensions in-process).
 */
export function adaptToPi(ext, config) {
    // Pi extensions are typically bundled and loaded by pi CLI, not adapted at runtime.
    // This function exists for potential future use.
    throw new Error("Pi extensions should be bundled via generatePiExtensionCode, not adapted at runtime");
}
//# sourceMappingURL=pi.js.map