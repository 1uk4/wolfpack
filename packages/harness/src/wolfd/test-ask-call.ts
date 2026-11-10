import type { ConsoleClient } from "@wolfpack/client";
import type { Card, CardAnswers } from "@wolfpack/protocol";
import { adaptToDurable } from "../adapters/durable.js";
import { Type } from "../extension-api.js";
import type { ExtensionRuntime } from "./run.js";
import { fauxToolCall } from "./scripted-model.js";

/** Test helper, used beside test-wolf.ts (the build compiles it like it does that file; nothing imports it at runtime).
 * The retired ask_user_question's argument shape, kept so card tests script an `ask` call in a few words. */
export interface AskArgs {
  question: string;
  details?: string;
  options?: { label: string; value?: string }[];
  multiSelect?: boolean;
  kind?: "confirm";
}

/** A scripted `ask` call: one page holding one required question. The field id is "answer" ("confirm" for yes/no). */
export function askCall(a: AskArgs) {
  return fauxToolCall("ask", {
    pages: [
      {
        title: "Question",
        questions: [
          {
            id: a.kind === "confirm" ? "confirm" : "answer",
            ask: a.question,
            required: true,
            ...(a.details ? { context: a.details } : {}),
            kind: a.kind === "confirm" ? "confirm" : a.options ? (a.multiSelect ? "multi" : "single") : "free",
            ...(a.options ? { choices: a.options.map((o) => ({ label: o.label, value: o.value ?? o.label, tradeoff: `Picks ${o.label}.` })) } : {}),
          },
        ],
      },
    ],
  });
}

type PagedClient = Pick<ConsoleClient, "getThread" | "saveCardPage" | "submitCard" | "answerCard">;

/**
 * Answer a pending card: a paged one the way the console does: save every page but the last as a draft, then submit the last
 * page's answers (one submission). `answers` is keyed by field id across all pages. Returns the submit ack.
 */
export async function answerPaged(client: PagedClient, threadId: string, callId: string, answers: CardAnswers) {
  const detail = await client.getThread(threadId);
  const card = detail.pendingCards?.find((p) => p.callId === callId)?.card;
  if (!card?.paged) return client.answerCard!(threadId, callId, answers); // a plain (non-paged) card, or an unknown call
  const steps = card.steps ?? [{ fields: Object.keys(answers) }];
  const forStep = (fields: readonly string[]) => Object.fromEntries(Object.entries(answers).filter(([id]) => fields.includes(id)));
  for (let i = 0; i < steps.length - 1; i++) await client.saveCardPage!(threadId, callId, i, forStep(steps[i].fields), { goto: i + 1 });
  return client.submitCard!(threadId, callId, { answers: forStep(steps[steps.length - 1].fields) });
}

/**
 * A test-only tool that raises a PLAIN (non-paged) card, the shape old transcripts and any custom tool still produce.
 * Tests of the per-card answer route (held siblings, validation, supersede) use it; wolfd itself has no such tool.
 * Install it through the hooks.extensions option of startTestWolf.
 */
export const plainCardExtension = (rt: ExtensionRuntime) =>
  adaptToDurable(
    {
      name: "plain-card",
      tools: [
        {
          name: "plain_card",
          description: "raise a plain card",
          raisesCard: true,
          parameters: Type.Object({}, { additionalProperties: true }),
          async execute(args: unknown) {
            const a = args as AskArgs;
            const id = a.kind === "confirm" ? "confirm" : "answer";
            const base = { id, label: a.question, ...(a.details ? { description: a.details } : {}) };
            const options = (a.options ?? []).map((o) => ({ label: o.label, value: o.value ?? o.label }));
            const field =
              a.kind === "confirm" ? { ...base, kind: "confirm" as const }
              : a.options ? { ...base, kind: a.multiSelect ? ("multi" as const) : ("single" as const), options, allowOther: !a.multiSelect }
              : { ...base, kind: "free-text" as const };
            return { content: [{ type: "text" as const, text: "asked" }], card: { tool: "plain_card", fields: [field] } as Card };
          },
        },
      ],
    },
    { wolfDen: rt.den, wolfName: "testwolf", onCardTool: rt.onCardTool },
  );

/** A scripted plain_card call (same arguments as askCall). */
export const plainCall = (a: AskArgs) => fauxToolCall("plain_card", JSON.parse(JSON.stringify(a)));
