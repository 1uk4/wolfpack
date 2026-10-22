/**
 * What the observer reads of a session branch.
 *
 * Only conversation messages (user / assistant / tool results) are
 * serialized. Extension-injected entries (`custom_message`, such as a
 * subagent's report delivered as a steer message) are not conversation, so
 * they are not read.
 *
 * A subagent report that was handed to the work Record explicitly
 * (the subagent was started with a workItem) additionally carries
 * `details[RECORDED_REPORT_KEY]` on its message. That marker is the contract:
 * whatever shape a pi version gives such an entry (a custom_message entry, or
 * a message with role "custom"), an entry that carries it is skipped, so the
 * report is never extracted a second time from the steer message.
 */

/** Set (true) in the `details` of a steer message whose content was recorded as work observations. */
export const RECORDED_REPORT_KEY = "recordedToWork";

/** True for a branch entry carrying the "already recorded" marker. */
export function isRecordedReport(entry: any): boolean {
  return entry?.details?.[RECORDED_REPORT_KEY] === true || entry?.message?.details?.[RECORDED_REPORT_KEY] === true;
}

export function serializeBranchEntries(entries: any[]): Array<{ id: string; text: string; tokens: number }> {
  const chunks: Array<{ id: string; text: string; tokens: number }> = [];

  for (const entry of entries) {
    if (isRecordedReport(entry)) continue;

    // Pi session entries: { type: "message", message: { role, content, ... } }
    // Also: "custom", "compaction", "model_change", "thinking_level_change", etc.
    if (entry.type !== "message") continue;

    const msg = entry.message;
    if (!msg) continue;

    const role: string = msg.role ?? "unknown";
    let text = "";

    if (role === "user" || role === "assistant") {
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");
      }
      // Assistant messages may have tool_use blocks
      if (role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            text += `\n[Tool call: ${block.name}(${JSON.stringify(block.input).slice(0, 500)})]`;
          }
        }
      }
    } else if (role === "tool") {
      // Tool result message
      const content = typeof msg.content === "string"
        ? msg.content.slice(0, 2000)
        : Array.isArray(msg.content)
          ? msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").slice(0, 2000)
          : JSON.stringify(msg.content).slice(0, 2000);
      text = `[Tool result: ${content}]`;
    }

    if (text.length > 0) {
      chunks.push({ id: entry.id, text: `[${role}] ${text}`, tokens: Math.ceil(text.length / 4) });
    }
  }

  return chunks;
}
