/**
 * Structured-object tools (`show_decision` now; checklist and graph add an entry to the protocol's OBJECT_TOOL_PARAMS).
 *
 * The tool itself is stateless: it validates the protocol schema and acks. The thread layer derives the object from
 * the call's arguments (events.ts live as `object-upsert`, messages.ts for history/snapshot), counting calls per
 * `objectId` for the rev, so history survives restarts without a side store.
 */
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { OBJECT_TOOL_PARAMS, objectToolJsonSchema, parseObjectData } from "@wolfpack/protocol";

type ObjectToolName = keyof typeof OBJECT_TOOL_PARAMS;

const DESCRIPTIONS: Record<ObjectToolName, string> = {
  show_decision:
    "Show the user a decision card: the options you weighed, which you chose and why. Use it when you settle a real choice " +
    "(approach, design, trade-off), not for trivia. Calling it again with the same objectId revises the card in place.",
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
  const { objectId, ...data } = r.data as { objectId: string };
  if (parseObjectData(spec.type, data) === undefined) return undefined;
  return { objectId, type: spec.type, data };
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
