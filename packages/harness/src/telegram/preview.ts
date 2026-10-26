/**
 * Live-preview text for one run, built from the engine event mapper so restreamed text (text_start/block/message
 * changes) is not dropped. Deltas append; a correction replaces the CURRENT message's text. With tool rounds the
 * preview is the concatenation of each message's text; a correction only rewrites the message it belongs to.
 */
import { createEventMapper, type EngineEvent } from "../engine/index.js";

export interface PreviewTracker {
  /** Feed engine events; returns the current preview text. */
  push(events: readonly EngineEvent[]): string;
  readonly text: string;
}

export function createPreviewTracker(): PreviewTracker {
  const mapper = createEventMapper();
  let text = "";
  let base = ""; // preview text before the current assistant message started
  return {
    push(events) {
      for (const event of events) {
        if (event.type === "message_start") base = text;
        for (const m of mapper.push([event])) {
          if (m.type === "text-delta") text += m.text;
          else if (m.type === "resync" && m.correction) text = base + m.correction.text;
        }
      }
      return text;
    },
    get text() {
      return text;
    },
  };
}
