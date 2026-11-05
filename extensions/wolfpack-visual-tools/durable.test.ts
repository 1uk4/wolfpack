import { describe, expect, it } from "vitest"
import { bundledAgentsDir, loadAgent } from "@wolfpack/agents"
import createVisualToolsExtension from "./durable.ts"

describe("wolfpack-visual-tools durable entry", () => {
  it("provides every non-builtin tool the bundled visualizer lists", () => {
    const def = loadAgent("visualizer", { cwd: bundledAgentsDir(), agentDir: bundledAgentsDir() })
    expect(def).not.toBeNull()
    const provided = new Set((createVisualToolsExtension().tools ?? []).map((t) => t.name))
    const builtin = new Set(["read", "grep", "find", "ls"])
    const wanted = (def?.tools ?? "").split(",").map((t) => t.trim()).filter((t) => t && !builtin.has(t))
    expect(wanted.length).toBe(6)
    for (const t of wanted) expect(provided.has(t)).toBe(true)
  })

  it("turns tool errors into error results", async () => {
    const edit = (createVisualToolsExtension().tools ?? []).find((t) => t.name === "edit_svg")!
    const res = await edit.execute({ old_text: "a", new_text: "b" }, {} as never)
    expect(res.isError).toBe(true)
  })
})
