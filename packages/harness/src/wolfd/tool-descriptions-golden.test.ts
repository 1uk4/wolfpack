/**
 * Golden snapshot of the tool descriptions a test wolf offers the model (the `tool.*` entries of its prompt catalog),
 * work-wolfpack-rruLly7. One fixture: fixtures/prompts/A-main-wolf/tool-descriptions.txt (name, source, description).
 * Parameter descriptions are not in the catalog (the server only gets name + description), so they are not covered here.
 *
 * A failure means a tool description changed. If deliberate, rewrite the fixture and commit it:
 *
 *   UPDATE_PROMPT_GOLDEN=1 wolfpack test run packages/harness/src/wolfd/tool-descriptions-golden.test.ts
 */
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { expectGolden } from "@wolfpack/engine/dist/golden.js";
import { fauxAssistantMessage } from "./scripted-model.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";

let tw: TestWolf | undefined;
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
});

it("the tool descriptions the wolf offers the model", async () => {
  tw = await startTestWolf({ script: [fauxAssistantMessage("ok")] });
  const res = await fetch(`${tw.url}/v1/wolves/testwolf/prompts`);
  const body = (await res.json()) as { prompts: Array<{ id: string; file?: string; text: string }> };
  const tools = body.prompts.filter((p) => p.id.startsWith("tool.")).sort((a, b) => (a.id < b.id ? -1 : 1));
  expect(tools.length).toBeGreaterThan(0);
  const out = tools.map((t) => `===== ${t.id} (${t.file}) =====\n${t.text}`).join("\n\n");
  expectGolden(join(__dirname, "fixtures", "prompts"), "A-main-wolf/tool-descriptions.txt", out);
});
