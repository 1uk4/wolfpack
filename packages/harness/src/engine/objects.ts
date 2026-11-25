/**
 * Structured-object tools (`show_decision`, `show_checklist`, `show_graph`; a new type adds an entry to the protocol's OBJECT_TOOL_PARAMS).
 *
 * The tool itself is stateless: it validates the protocol schema and acks. The thread layer derives the object from
 * the call's arguments (events.ts live as `object-upsert`, messages.ts for history/snapshot), rev = successful
 * completed calls per `objectId` (the rule lives in the protocol's objects.ts), so history survives restarts without a
 * side store. A future harness-originated revision (no tool call) would plug in here: it needs a server-side source
 * of upserts that events.ts and messages.ts both read.
 */
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { OBJECT_TOOL_PARAMS, PinParamsSchema, objectToolJsonSchema, parseObjectData, pinToolJsonSchema, type ObjectToolName } from "@wolfpack/protocol";
import { readBindingFile } from "@wolfpack/memory";
import { conversationReaderFor } from "./conversation-reader.js";

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
  show_view:
    "Open a work item (kind work-item) or a KB entry (kind kb-entry) in the owner's viewer panel and leave a small card in the " +
    "transcript. Pass the full id. Calling it again with the same objectId revises it in place; pinned: true also pins it as a chip. " +
    "Kind frame shows an HTML file the visualizer wrote in your frames dir: pass wolf (your own name) and path (relative to the frames dir, e.g. pack-health.html). " +
    "For visuals, delegate to the visualizer, then call show_view with kind frame and the path it returns; after it rewrites the file, call again with the same objectId to reload.",
};

const NAMES = Object.keys(OBJECT_TOOL_PARAMS) as ObjectToolName[];
const isObjectTool = (name: string | undefined): name is ObjectToolName => name !== undefined && Object.hasOwn(OBJECT_TOOL_PARAMS, name);

export interface ObjectCall {
  objectId: string;
  type: string;
  data: unknown;
  /** The call's explicit `pinned`; absent when omitted (auto-pin). */
  pinned?: boolean;
}

export const PIN_TOOL = "pin";
/** Reserved `pin` objectId: the bound-task chip, not a transcript object. */
export const TASK_PIN_ID = "task";

/** The pin action of a `pin` tool call, or undefined (not the pin tool, or arguments that fail the schema). */
export function pinFromCall(name: string | undefined, args: unknown): { objectId: string; pinned: boolean } | undefined {
  if (name !== PIN_TOOL) return undefined;
  const r = PinParamsSchema.safeParse(args);
  return r.success ? r.data : undefined;
}

/** The object a tool call shows, or undefined (not an object tool, or arguments that fail the schema). */
export function objectFromCall(name: string | undefined, args: unknown): ObjectCall | undefined {
  if (!isObjectTool(name)) return undefined;
  const spec = OBJECT_TOOL_PARAMS[name];
  const r = spec.schema.safeParse(args);
  if (!r.success) return undefined;
  const { objectId, pinned, ...rest } = r.data as { objectId: string; pinned?: boolean };
  const data = parseObjectData(spec.type, rest);
  return data === undefined ? undefined : { objectId, type: spec.type, data, ...(pinned !== undefined ? { pinned } : {}) };
}

let warnedNoReader = false;

/**
 * Whether a valid, not-failed show call for `objectId` is in this conversation's history (fork-inherited included).
 * In the assistant message holding the pin call itself, only show calls before the pin count.
 */
async function objectShown(den: string, conversationId: number, objectId: string, pinCallId: string): Promise<boolean> {
  const reader = conversationReaderFor(den);
  if (!reader) {
    // cannot look (no reader registered): do not block the pin, but make a mis-wired engine visible
    if (!warnedNoReader) {
      warnedNoReader = true;
      console.warn(`[objects] no conversation reader for ${den}: the pin tool cannot check that the object exists`);
    }
    return true;
  }
  const messages = await reader.messagesInHistory(conversationId);
  const failed = new Set<string>();
  for (const { message } of messages) {
    const m = message as { role?: string; toolCallId?: string; isError?: boolean };
    if (m.role === "toolResult" && m.isError === true && m.toolCallId) failed.add(m.toolCallId);
  }
  for (const { message } of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const b of message.content as Array<{ type: string; id?: string; name?: string; arguments?: unknown }>) {
      if (b.type === "toolCall" && b.id === pinCallId) break; // later calls in this message are not shown yet
      if (b.type === "toolCall" && !(b.id && failed.has(b.id)) && objectFromCall(b.name, b.arguments)?.objectId === objectId) return true;
    }
  }
  return false;
}

const PIN_DESCRIPTION =
  "Pin or unpin a checklist, decision or graph already shown in this thread, without resending it. Pinned objects show in the strip " +
  "at the top of the chat (new objects pin automatically, the newest of each type); pin an older one to show it instead of the newest, " +
  "or unpin one to take it out. Errors if no object has that objectId. The reserved objectId \"task\" is the bound-task chip: " +
  "pinned false hides it, true shows it again (the binding never changes; errors when no task is bound).";

/** `den` is the wolf's den: where the engine registers the conversation reader the pin tool uses to find the object. */
/** Frame support: the wolf's name and a check of a frame path against its frames dir (an error message, or undefined when the file is fine). */
export interface FrameOptions {
  wolf: string;
  check(path: string): string | undefined | Promise<string | undefined>;
}

/** Why a frame view cannot be shown (wrong wolf, missing or oversize file), or undefined. Other view kinds pass. */
async function frameRefusal(data: unknown, frames: FrameOptions | undefined): Promise<string | undefined> {
  const v = data as { kind?: string; path?: string; wolf?: string };
  if (v.kind !== "frame") return undefined;
  if (!frames) return "This wolf has no frames dir, so it cannot show frames.";
  if (v.wolf !== frames.wolf) return `wolf must be your own name, "${frames.wolf}".`;
  return frames.check(v.path ?? "");
}

export function createObjectsExtension(den: string, frames?: FrameOptions) {
  return defineExtension({
    name: "wolfpack-objects",
    tools: [
      ...NAMES.map((name) =>
        defineTool({
          name,
          description: DESCRIPTIONS[name],
          parameters: objectToolJsonSchema(name) as never,
          async execute(args: unknown) {
            const o = objectFromCall(name, args);
            const refused = o && name === "show_view" ? await frameRefusal(o.data, frames) : undefined;
            if (refused) return { output: [{ type: "text" as const, text: refused }], isError: true };
            return o
              ? { output: [{ type: "text" as const, text: `Shown ${o.type} "${o.objectId}".` }] }
              : { output: [{ type: "text" as const, text: "Invalid arguments." }], isError: true };
          },
        }),
      ),
      defineTool({
        name: PIN_TOOL,
        description: PIN_DESCRIPTION,
        parameters: pinToolJsonSchema() as never,
        async execute(args: unknown, api: ToolExecutionApi) {
          const p = pinFromCall(PIN_TOOL, args);
          if (!p) return { output: [{ type: "text" as const, text: "Invalid arguments." }], isError: true };
          if (p.objectId === TASK_PIN_ID) {
            if (!readBindingFile(den, Number(api.conversationId))?.workId) {
              return { output: [{ type: "text" as const, text: "No task is bound to this thread, so there is no task chip to pin or unpin." }], isError: true };
            }
            return { output: [{ type: "text" as const, text: `${p.pinned ? "Pinned" : "Unpinned"} "task".` }] };
          }
          if (!(await objectShown(den, Number(api.conversationId), p.objectId, api.callId))) {
            return { output: [{ type: "text" as const, text: `No object "${p.objectId}" in this thread. Show it first with show_checklist, show_decision or show_graph.` }], isError: true };
          }
          return { output: [{ type: "text" as const, text: `${p.pinned ? "Pinned" : "Unpinned"} "${p.objectId}".` }] };
        },
      }),
    ],
  });
}
