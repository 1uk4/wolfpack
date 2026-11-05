/**
 * wolfpack-visual-tools, pi-durable entry.
 *
 * wolfd's subagents get their tools from the extensions the wolf loads, so the
 * Mermaid/SVG tools must be registered through the unified extension API. The
 * tool files are written against pi's `registerTool`; this entry runs them
 * against a capturing shim and exposes the captured tools as unified Tools.
 *
 * The unified ToolResult is text-only, so inline image blocks are replaced by a
 * note: the PNG path is already in the text of a published render.
 */
import { defineExtension, type Tool, type ToolResult } from "@wolfpack/harness/extension"
import mermaidTools from "./tools/mermaid_tools.ts"
import svgTools from "./tools/svg_tools.ts"

interface PiTool {
  name: string
  description: string
  parameters: unknown
  execute: (id: string, params: unknown, ...rest: unknown[]) => Promise<{ content: Array<{ type: string; text?: string }> }>
}

export function captureTools(): Tool[] {
  const captured: PiTool[] = []
  const shim = { registerTool: (t: PiTool) => void captured.push(t) }
  mermaidTools(shim as never)
  svgTools(shim as never)
  return captured.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters as Tool["parameters"],
    async execute(args): Promise<ToolResult> {
      try {
        const res = await t.execute(`${t.name}-${Date.now()}`, args)
        const text = res.content
          .map((c) => (c.type === "text" ? (c.text ?? "") : "[rendered image omitted: this runtime cannot show images inline; use the published PNG path]"))
          .join("\n")
        return { content: [{ type: "text", text }] }
      } catch (err) {
        return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true }
      }
    },
  }))
}

export default function createVisualToolsExtension() {
  return defineExtension({ name: "wolfpack-visual-tools", runtimes: ["pi-durable"], tools: captureTools() })
}
