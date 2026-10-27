/**
 * Structured-object tools (`show_decision`, `show_checklist`, `show_graph`; a new type adds an entry to the protocol's OBJECT_TOOL_PARAMS).
 *
 * The tool itself is stateless: it validates the protocol schema and acks. The thread layer derives the object from
 * the call's arguments (events.ts live as `object-upsert`, messages.ts for history/snapshot), rev = successful
 * completed calls per `objectId` (the rule lives in the protocol's objects.ts), so history survives restarts without a
 * side store. A future harness-originated revision (no tool call) would plug in here: it needs a server-side source
 * of upserts that events.ts and messages.ts both read.
 */
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { OBJECT_TOOL_PARAMS, objectToolJsonSchema, parseObjectData, type ObjectToolName } from "@wolfpack/protocol";

const DESCRIPTIONS: Record<ObjectToolName, string> = {
  show_decision:
    "Show the user a decision card: the options you weighed, which you chose and why. Use it when you settle a real choice " +
    "(approach, design, trade-off), not for trivia. Calling it again with the same objectId revises the card in place; " +
    "each revision must resend the full decision, not a diff.",
  show_checklist:
    "Show the user a live checklist of the steps of a multi-step task, each todo, doing, done or skipped. Call it when you start, " +
    "then again with the same objectId as items change state; each call revises the card in place and must resend the full " +
    "checklist (every item, unique ids), not a diff.",
  show_graph:
    "Show the user a plan/task graph: nodes (kind step|task|milestone, status todo|doing|done|blocked|skipped) and edges " +
    "{from,to} meaning `from` depends on `to`. Edges must reference node ids, with no self-loops or cycles. Call it again " +
    "with the same objectId as work progresses to update statuses in place; each revision must resend the full graph, not a diff.",
};

const NAMES = Object.keys(OBJECT_TOOL_PARAMS) as ObjectToolName[];
const isObjectTool = (name: string | undefined): name is ObjectToolName => name !== undefined && Object.hasOwn(OBJECT_TOOL_PARAMS, name);

export interface ObjectCall {
  objectId: string;
  type: string;
  data: unknown;
}

/** The object a tool call shows, or undefined (not an object tool, or arguments that fail the schema). */
export function objectFromCall(name: string | undefined, args: unknown): ObjectCall | undefined {
  if (!isObjectTool(name)) return undefined;
  const spec = OBJECT_TOOL_PARAMS[name];
  const r = spec.schema.safeParse(args);
  if (!r.success) return undefined;
  const { objectId, ...rest } = r.data as { objectId: string };
  const data = parseObjectData(spec.type, rest);
  return data === undefined ? undefined : { objectId, type: spec.type, data };
}

export const objectsExtension = defineExtension({
  name: "wolfpack-objects",
  tools: NAMES.map((name) =>
    defineTool({
      name,
      description: DESCRIPTIONS[name],
      parameters: objectToolJsonSchema(name) as never,
      async execute(args: unknown) {
        const o = objectFromCall(name, args);
        return o
          ? { output: [{ type: "text" as const, text: `Shown ${o.type} "${o.objectId}".` }] }
          : { output: [{ type: "text" as const, text: "Invalid arguments." }], isError: true };
      },
    }),
  ),
});
