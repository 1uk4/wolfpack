import { describe, expect, it } from "vitest";
import { reduce, renderWizard, wizardSingleChoice, type WizardState } from "./crawl-wizard.js";

const OPTIONS = [
  { label: "One", value: "1", description: "first" },
  { label: "Two", value: "2" },
];
const start: WizardState = { cursor: 0, typing: null };
const theme = { fg: (_c: string, t: string) => t };

describe("crawl wizard", () => {
  it("moves within the list and picks the option under the cursor", () => {
    let step = reduce(start, "down", OPTIONS, false);
    expect(step).toEqual({ state: { cursor: 1, typing: null } });
    step = reduce((step as { state: WizardState }).state, "down", OPTIONS, false); // clamped at the end
    expect((step as { state: WizardState }).state.cursor).toBe(1);
    expect(reduce({ cursor: 1, typing: null }, "enter", OPTIONS, false)).toEqual({ done: "2" });
    expect(reduce(start, "up", OPTIONS, false)).toEqual({ state: start });
  });

  it("escape cancels the list", () => {
    expect(reduce(start, "escape", OPTIONS, false)).toEqual({ done: null });
  });

  it("the Other row opens a text entry; escape goes back, an empty entry is not accepted", () => {
    const onOther: WizardState = { cursor: 2, typing: null };
    const typing = (reduce(onOther, "enter", OPTIONS, true) as { state: WizardState }).state;
    expect(typing.typing).toBe("");
    expect(reduce(typing, "enter", OPTIONS, true)).toEqual({ state: typing });
    const typed = (reduce(typing, { text: "ab" }, OPTIONS, true) as { state: WizardState }).state;
    const fixed = (reduce(typed, "backspace", OPTIONS, true) as { state: WizardState }).state;
    expect(reduce(fixed, { text: "c" }, OPTIONS, true)).toEqual({ state: { cursor: 2, typing: "ac" } });
    expect(reduce({ cursor: 2, typing: " 7 " }, "enter", OPTIONS, true)).toEqual({ done: "7" });
    expect(reduce(typed, "escape", OPTIONS, true)).toEqual({ state: { cursor: 2, typing: null } });
  });

  it("renders the title, numbered options, the cursor and the hint", () => {
    const text = renderWizard(theme, 60, "Pick", "some context", OPTIONS, true, start).join("\n");
    expect(text).toContain("Pick");
    expect(text).toContain("some context");
    expect(text).toContain("> 1. One");
    expect(text).toContain("2. Two");
    expect(text).toContain("Other…");
    expect(text).toContain("Esc cancel");
  });

  it("mounts through ctx.ui.custom and resolves with the chosen value", async () => {
    let component: { handleInput(d: string): void } | undefined;
    const ctx = {
      ui: {
        custom: (factory: (...a: unknown[]) => typeof component) =>
          new Promise((resolve) => {
            component = factory({ requestRender() {} }, theme, undefined, resolve);
          }),
      },
    };
    const pending = wizardSingleChoice(ctx, "Pick", undefined, OPTIONS);
    component!.handleInput("\u001b[B"); // down
    component!.handleInput("\r"); // enter
    await expect(pending).resolves.toBe("2");
  });
});
