/** Multi / confirm card fields end to end over /v1 (real pi-durable turns, scripted model): validation, defaults, siblings. */
import { afterEach, describe, expect, it } from "vitest";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Card, CardAnswers } from "@wolfpack/protocol";
import { CardSchema } from "@wolfpack/protocol";
import { cardResult, confirmCard } from "../engine/cards.js";
import { fauxAssistantMessage, fauxToolCall } from "./scripted-model.js";
import { adaptToDurable } from "../adapters/durable.js";
import { Type } from "../extension-api.js";
import type { ExtensionRuntime } from "./run.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";
import { answerText, answerValue, validateAnswers } from "./cards.js";

let tw: TestWolf | undefined;
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
});

const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const drain = async (w: TestWolf) => {
  for await (const _ of w.client.watch(w.home));
};
const lastUserText = (context: { messages: { role: string; content: unknown }[] }): string => {
  const u = context.messages.filter((m) => m.role === "user").at(-1);
  return typeof u?.content === "string" ? u.content : JSON.stringify(u?.content);
};

const OPTS = [{ label: "Alpha", value: "a" }, { label: "Beta", value: "b" }, { label: "Gamma", value: "c" }];
const MULTI: Card = { tool: "raise", fields: [{ id: "m", kind: "multi", label: "Pick some", options: OPTS, min: 1, max: 2, default: ["a"] }] };
const MULTI_OTHER: Card = { tool: "raise", fields: [{ id: "m", kind: "multi", label: "Pick some", options: OPTS, allowOther: true }] };
const CONFIRM: Card = confirmCard({ tool: "raise", question: "Ship it?", confirmLabel: "Ship", rejectLabel: "Hold", default: true });

/** A durable tool raising the card named by its `key` argument. */
const raiser = (cards: Record<string, Card>) =>
  defineExtension({
    name: "raiser",
    tools: [
      defineTool({
        name: "raise",
        description: "raise a card",
        parameters: { type: "object" as const, properties: { key: { type: "string" } }, required: ["key"] },
        async execute(args: { key: string }) {
          return cardResult(cards[args.key]);
        },
      }),
    ],
  });

const raise = (key: string) => fauxToolCall("raise", { key });
const wolfWith = (cards: Record<string, Card>, script: Parameters<typeof startTestWolf>[0]["script"]) => startTestWolf({ script, hooks: { extensions: [raiser(cards)] } });

describe("card field kind validation (pure)", () => {
  const ok = (card: Card, answers: CardAnswers) => expect(validateAnswers(card, answers)).toBeUndefined();
  const bad = (card: Card, answers: CardAnswers, re: RegExp) => expect(validateAnswers(card, answers)).toMatch(re);

  it("multi: subset of options within min/max; other needs allowOther and a named custom entry", () => {
    ok(MULTI, { m: { value: ["a"] } });
    ok(MULTI, { m: { value: ["a", "c"] } });
    bad(MULTI, { m: { value: [] } }, /at least 1/);
    bad(MULTI, { m: { value: ["a", "b", "c"] } }, /at most 2/);
    bad(MULTI, { m: { value: ["zzz"] } }, /not an option/);
    bad(MULTI, { m: { value: ["a", "a"] } }, /duplicate/);
    bad(MULTI, { m: { value: "a" } }, /list of strings/);
    bad(MULTI, { m: { value: true } }, /list of strings/);
    bad(MULTI, { m: { value: ["a", "x"], other: ["x"] } }, /does not accept custom/); // allowOther unset
    ok(MULTI_OTHER, { m: { value: ["a", "x"], other: ["x"] } });
    bad(MULTI_OTHER, { m: { value: [] } }, /at least 1/); // a required multi needs a pick, with or without min
    bad(MULTI_OTHER, { m: { value: ["x"] } }, /not an option/); // custom entry not declared in `other`
    bad(MULTI_OTHER, { m: { value: ["a"], other: ["x"] } }, /not among the picked/);
    bad(MULTI_OTHER, { m: { value: ["  "], other: ["  "] } }, /cannot be empty/);
    bad(MULTI_OTHER, { m: { value: ["b"], other: ["b"] } }, /duplicates an option value/); // custom == option value
    bad(MULTI_OTHER, { m: { value: [" b "], other: [" b "] } }, /duplicates an option value/); // whitespace doesn't dodge it
  });

  it("confirm: boolean only", () => {
    ok(CONFIRM, { confirm: { value: true } });
    ok(CONFIRM, { confirm: { value: false, note: "not yet" } });
    bad(CONFIRM, { confirm: { value: "yes" } }, /true or false/);
    bad(CONFIRM, { confirm: { value: ["x"] } }, /true or false/);
    bad(CONFIRM, {}, /missing answer/);
  });

  it("the kind decides the answer type for the other kinds too", () => {
    const single: Card = { tool: "t", fields: [{ id: "s", kind: "single", label: "s", options: OPTS }] };
    bad(single, { s: { value: true } }, /must be a string/);
    bad(single, { s: { value: ["a"] } }, /must be a string/);
    const free: Card = { tool: "t", fields: [{ id: "f", kind: "free-text", label: "f" }] };
    bad(free, { f: { value: false } }, /must be a string/);
  });

  it("answerText: comma list for multi, labelled yes/no for confirm, raise order", () => {
    const text = answerText([
      { callId: "c1", card: MULTI, answers: { m: { value: ["a", "c"] } } },
      { callId: "c2", card: CONFIRM, answers: { confirm: { value: false } } },
      { callId: "c3", card: { ...CONFIRM, fields: [{ ...CONFIRM.fields[0], default: undefined }] }, answers: { confirm: { value: true, note: "go" } } },
    ]);
    expect(text).toBe(
      [
        "The user answered your raise question (call c1):",
        "- Pick some: Alpha (a), Gamma (c)",
        "The user answered your raise question (call c2):",
        "- Ship it?: no (Hold)",
        "The user answered your raise question (call c3):",
        "- Ship it?: yes (Ship) — go",
      ].join("\n"),
    );
    expect(answerText([{ callId: "c", card: MULTI, answers: { m: { value: [] } } }])).toContain("(none selected)");
  });

  it("answerValue for multi: labels with values, custom entries marked, commas and quotes inside entries are quoted", () => {
    const card: Card = {
      tool: "t",
      fields: [{ id: "m", kind: "multi", label: "Colours", allowOther: true, options: [{ label: "Red", value: "red" }, { label: "Same", value: "Same" }, { label: "Red, dark", value: "dark" }] }],
    };
    expect(answerValue(card.fields[0], { value: ["red"] })).toBe("Red (red)");
    expect(answerValue(card.fields[0], { value: ["red", "Same", "dark", "teal, ish", 'say "hi"'], other: ["teal, ish", 'say "hi"'] })).toBe(
      'Red (red), Same, "Red, dark (dark)", other: "teal, ish", other: "say \\"hi\\""',
    );
  });
});

describe("card schema", () => {
  it("rejects a multi default outside the options or outside min/max, and min > max", () => {
    const withField = (f: object) => CardSchema.safeParse({ tool: "t", fields: [{ id: "m", kind: "multi", label: "m", options: OPTS, ...f }] }).success;
    expect(withField({ default: ["a"] })).toBe(true);
    expect(withField({ default: ["nope"] })).toBe(false);
    expect(withField({ default: ["a", "b"], max: 1 })).toBe(false);
    expect(withField({ default: ["a"], min: 2 })).toBe(false);
    expect(withField({ min: 3, max: 2 })).toBe(false);
    const msg = (f: object) => {
      const r = CardSchema.safeParse({ tool: "t", fields: [{ id: "m", kind: "multi", label: "m", options: OPTS, ...f }] });
      return r.success ? "ok" : r.error.issues[0].message;
    };
    expect(msg({ default: ["a", "a"] })).toMatch(/must not repeat/);
    expect(msg({ min: 4 })).toMatch(/can never be satisfied/);
    expect(msg({ min: 4, allowOther: true })).toBe("ok");
    expect(msg({ min: 3 })).toBe("ok");
    expect(msg({ min: 3, max: 2, allowOther: true })).toMatch(/min must not exceed its max/);
    expect(msg({ default: ["nope"] })).toMatch(/subset/);
    expect(msg({ default: ["a"], min: 2, allowOther: true })).toMatch(/respect its min and max/);
    expect(CardSchema.safeParse({ tool: "t", fields: [{ id: "c", kind: "confirm", label: "c", default: "yes" }] }).success).toBe(false);
  });
});

describe("multi / confirm cards over /v1", () => {
  it("multi: invalid answers are 400 and change nothing; the default is never auto-submitted; a valid answer starts the next turn", async () => {
    let seen = "";
    tw = await wolfWith({ m: MULTI }, [
      toolUse(raise("m")),
      (context) => {
        seen = lastUserText(context as never);
        return fauxAssistantMessage("ok");
      },
    ]);
    await tw.submit("go");
    const d0 = await tw.client.getThread(tw.home);
    expect(d0.status).toBe("needs-you");
    const [p] = d0.pendingCards!;
    expect(p.card.fields[0]).toMatchObject({ kind: "multi", default: ["a"], min: 1, max: 2 });
    expect(p.heldAnswer).toBeUndefined(); // the default only pre-selects client-side
    expect(tw.scripted.faux.state.callCount).toBe(1);

    const invalid: CardAnswers[] = [
      {},
      { m: { value: [] } }, // under min
      { m: { value: ["a", "b", "c"] } }, // over max
      { m: { value: ["zzz"] } }, // non-option without allowOther
      { m: { value: ["x"], other: ["x"] } }, // allowOther unset
      { m: { value: "a" } }, // wrong type
    ];
    for (const bad of invalid) await expect(tw.client.answerCard!(tw.home, p.callId, bad)).rejects.toMatchObject({ code: "invalid_request" });
    const still = await tw.client.getThread(tw.home);
    expect(still.status).toBe("needs-you");
    expect(still.pendingCards![0].heldAnswer).toBeUndefined();
    expect(tw.scripted.faux.state.callCount).toBe(1);

    expect((await tw.client.answerCard!(tw.home, p.callId, { m: { value: ["b", "c"] } })).disposition).toBe("started");
    await drain(tw);
    expect(seen).toContain("- Pick some: Beta (b), Gamma (c)");
    const done = await tw.client.getThread(tw.home);
    expect(done.status).toBe("idle");
    const call = done.messages.flatMap((m) => m.tools ?? [])[0];
    expect(call.answer).toEqual({ m: { value: ["b", "c"] } });
    expect(call.result).toBe("Beta (b), Gamma (c)");
  });

  it("multi with allowOther accepts custom entries, and the model sees them", async () => {
    let seen = "";
    tw = await wolfWith({ m: MULTI_OTHER }, [
      toolUse(raise("m")),
      (context) => {
        seen = lastUserText(context as never);
        return fauxAssistantMessage("ok");
      },
    ]);
    await tw.submit("go");
    const [p] = (await tw.client.getThread(tw.home)).pendingCards!;
    await tw.client.answerCard!(tw.home, p.callId, { m: { value: ["a", "my own"], other: ["my own"] } });
    await drain(tw);
    expect(seen).toContain('- Pick some: Alpha (a), other: "my own"');
  });

  it("confirm: only a boolean is accepted; the default is not submitted; confirm and reject both resume the turn", async () => {
    for (const choice of [true, false]) {
      let seen = "";
      tw = await wolfWith({ c: CONFIRM }, [
        toolUse(raise("c")),
        (context) => {
          seen = lastUserText(context as never);
          return fauxAssistantMessage("ok");
        },
      ]);
      await tw.submit("go");
      const [p] = (await tw.client.getThread(tw.home)).pendingCards!;
      expect(p.card.fields[0]).toMatchObject({ kind: "confirm", default: true, confirmLabel: "Ship", rejectLabel: "Hold" });
      expect(p.heldAnswer).toBeUndefined();
      expect(tw.scripted.faux.state.callCount).toBe(1);
      for (const bad of [{ confirm: { value: "yes" } }, { confirm: { value: ["x"] } }, {}] as unknown as CardAnswers[]) {
        await expect(tw.client.answerCard!(tw.home, p.callId, bad)).rejects.toMatchObject({ code: "invalid_request" });
      }
      await tw.client.answerCard!(tw.home, p.callId, { confirm: { value: choice } });
      await drain(tw);
      expect(seen).toContain(choice ? "- Ship it?: yes (Ship)" : "- Ship it?: no (Hold)");
      expect((await tw.client.getThread(tw.home)).messages.flatMap((m) => m.tools ?? [])[0].result).toBe(choice ? "yes (Ship)" : "no (Hold)");
      await tw.stop();
      tw = undefined;
    }
  });

  it("ask_user_question raises multi (multiSelect) and confirm (kind) cards", async () => {
    tw = await startTestWolf({
      script: [
        toolUse(
          fauxToolCall("ask_user_question", { question: "Which?", options: [{ label: "X" }, { label: "Y" }], multiSelect: true }),
          fauxToolCall("ask_user_question", { question: "Sure?", kind: "confirm", confirmLabel: "Do it" }),
          fauxToolCall("ask_user_question", { question: "One?", options: [{ label: "P" }] }),
        ),
      ],
    });
    await tw.submit("go");
    const fields = (await tw.client.getThread(tw.home)).pendingCards!.map((p) => p.card.fields[0]);
    expect(fields[0]).toMatchObject({ kind: "multi", allowOther: true, options: [{ value: "X" }, { value: "Y" }] });
    expect(fields[1]).toMatchObject({ kind: "confirm", label: "Sure?", confirmLabel: "Do it" });
    expect(fields[2]).toMatchObject({ kind: "single" });
  });

  it("three sibling cards of mixed kinds answered out of order: one turn, after the last answer, in raise order", async () => {
    let seen = "";
    const free: Card = { tool: "raise", fields: [{ id: "f", kind: "free-text", label: "Why?" }] };
    tw = await wolfWith({ m: MULTI, c: CONFIRM, f: free }, [
      toolUse(raise("m"), raise("c"), raise("f")),
      (context) => {
        seen = lastUserText(context as never);
        return fauxAssistantMessage("ok");
      },
    ]);
    await tw.submit("go");
    const cards = (await tw.client.getThread(tw.home)).pendingCards!;
    expect(cards.map((p) => p.card.fields[0].kind)).toEqual(["multi", "confirm", "free-text"]);
    // third, then first, then second
    expect((await tw.client.answerCard!(tw.home, cards[2].callId, { f: { value: "because" } })).disposition).toBe("queued");
    expect(tw.scripted.faux.state.callCount).toBe(1);
    expect((await tw.client.answerCard!(tw.home, cards[0].callId, { m: { value: ["a"] } })).disposition).toBe("queued");
    expect(tw.scripted.faux.state.callCount).toBe(1);
    const mid = await tw.client.getThread(tw.home);
    expect(mid.status).toBe("needs-you");
    expect(mid.pendingCards!.map((p) => p.heldAnswer)).toEqual([{ m: { value: ["a"] } }, undefined, { f: { value: "because" } }]);
    // an invalid answer for the last one neither completes nor disturbs the held ones
    await expect(tw.client.answerCard!(tw.home, cards[1].callId, { confirm: { value: "maybe" } } as never)).rejects.toMatchObject({ code: "invalid_request" });
    expect(tw.scripted.faux.state.callCount).toBe(1);
    expect((await tw.client.answerCard!(tw.home, cards[1].callId, { confirm: { value: false } })).disposition).toBe("started");
    await drain(tw);

    expect(tw.scripted.faux.state.callCount).toBe(2); // exactly one turn started
    const order = ["- Pick some: Alpha (a)", "- Ship it?: no (Hold)", "- Why?: because"].map((l) => seen.indexOf(l));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order); // raise order, not answer order
    const done = await tw.client.getThread(tw.home);
    expect(done.status).toBe("idle");
    expect(done.pendingCards).toBeUndefined();
  });
});

describe("confirmCard through different raising paths (ticket 5 shape)", () => {
  const plain = defineExtension({
    name: "plain",
    tools: [defineTool({ name: "plain", description: "p", parameters: { type: "object" as const, properties: {}, required: [] }, async execute() { return { output: [{ type: "text" as const, text: "p" }] }; } })],
  });

  it("a raisesCard adapted tool (not ask_user_question) returning confirmCard: the guard ends a round with a sibling tool; the answer resumes", async () => {
    let seen = "";
    const mk = (rt: ExtensionRuntime) =>
      adaptToDurable(
        {
          name: "gate-ext",
          tools: [
            {
              name: "ship_gate",
              description: "ask before shipping",
              raisesCard: true,
              parameters: Type.Object({}),
              async execute() {
                return { content: [{ type: "text", text: "asked" }], card: confirmCard({ tool: "ship_gate", question: "Ship it?", confirmLabel: "Ship", rejectLabel: "Not yet" }) };
              },
            },
          ],
        },
        { wolfDen: rt.den, wolfName: "testwolf", onCardTool: rt.onCardTool },
      );
    tw = await startTestWolf({
      script: [
        toolUse(raise("x"), fauxToolCall("ship_gate", {}), fauxToolCall("plain", {})),
        (context) => {
          seen = lastUserText(context as never);
          return fauxAssistantMessage("shipped");
        },
      ],
      hooks: { extensions: (rt) => [mk(rt), plain, raiser({ x: CONFIRM })] },
    });
    await tw.submit("go");
    expect(tw.scripted.faux.state.callCount).toBe(1); // the card tool + siblings end the round
    const pending = (await tw.client.getThread(tw.home)).pendingCards!;
    expect(pending.map((p) => p.card.tool)).toEqual(["raise", "ship_gate"]);
    expect(pending[1].card.fields[0]).toMatchObject({ kind: "confirm", id: "confirm", confirmLabel: "Ship" });
    expect(pending[1].card.fields[0]).not.toHaveProperty("default"); // ship gates pre-select nothing
    await tw.client.answerCard!(tw.home, pending[0].callId, { confirm: { value: false } });
    expect((await tw.client.answerCard!(tw.home, pending[1].callId, { confirm: { value: true } })).disposition).toBe("started");
    await drain(tw);
    expect(seen).toContain("- Ship it?: yes (Ship)");
    expect(tw.scripted.faux.state.callCount).toBe(2);
  });

  it("a native tool returning cardResult(confirmCard) is guarded once registered (extra list / register)", async () => {
    const native = defineExtension({
      name: "native-gate",
      tools: [
        defineTool({
          name: "native_gate",
          description: "gate",
          parameters: { type: "object" as const, properties: {}, required: [] },
          async execute() {
            return cardResult(confirmCard({ tool: "native_gate", question: "Proceed?", default: false }));
          },
        }),
      ],
    });
    tw = await startTestWolf({
      script: [toolUse(fauxToolCall("native_gate", {}), fauxToolCall("plain", {})), fauxAssistantMessage("must not run")],
      hooks: {
        extensions: (rt) => {
          rt.onCardTool("native_gate"); // bypasses adaptToDurable: declared explicitly
          return [native, plain];
        },
      },
    });
    await tw.submit("go");
    expect(tw.scripted.faux.state.callCount).toBe(1);
    const [p] = (await tw.client.getThread(tw.home)).pendingCards!;
    expect(p.card).toMatchObject({ tool: "native_gate", fields: [{ kind: "confirm", default: false }] });
  });
});
