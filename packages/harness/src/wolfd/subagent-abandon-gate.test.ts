import { describe, expect, it } from "vitest";
import type { Card } from "@wolfpack/protocol";
import type { ToolContext } from "../extension-api.js";
import { abandonGate } from "./subagent-tools.js";

const BRANCH = "feat/kid";
const conflictCard = (tool: string): Card =>
  ({
    tool,
    fields: [
      {
        id: "q1",
        kind: "single",
        label: `Merge conflict merging ${BRANCH} into feat/home: README.md`,
        options: [{ label: "Abandon branch", value: "abandon" }, { label: "I'll do it", value: "manual" }],
      },
    ],
  }) as unknown as Card;

/** A gate whose only card lives under `tool` (the raising tool's name) and carries `value` as the owner's answer. */
async function gate(tool: string, value: string) {
  const bridge = { require: () => ({ abandonInfo: async () => ({ branch: BRANCH, unmerged: 2, dirty: 0 }) }) };
  const asked: string[] = [];
  const ctx = {
    conversationId: 1,
    conversation: {
      latestCard: async (name: string, matches: (c: Card) => boolean) => {
        asked.push(name);
        const card = conflictCard(tool);
        if (name !== tool || !matches(card)) return undefined;
        return { status: "answered", card, answers: { q1: { value } }, laterResults: [] };
      },
    },
  } as unknown as ToolContext;
  return { result: await abandonGate(bridge as never, "subagent_merge", ctx, "kid"), asked };
}

describe("abandon gate and the conflict card", () => {
  it.each(["ask", "brief", "ask_user_question"])("a conflict card raised by %s with the owner's abandon lets the abandon through", async (tool) => {
    const { result, asked } = await gate(tool, "abandon");
    expect(result).toBeUndefined();
    expect(asked).toContain(tool);
  });

  it.each(["ask", "brief", "ask_user_question"])("a conflict card raised by %s answered with another choice does not", async (tool) => {
    const { result } = await gate(tool, "manual");
    expect(result).toBeDefined();
  });
});
