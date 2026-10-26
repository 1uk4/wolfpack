/**
 * What the observer reads of a session branch: conversation messages only
 * (user / assistant / tool results). Extension-injected `custom_message`
 * entries (subagent reports, status, notifications) are not read; the
 * orchestrator relays what matters in its own words.
 */
export function serializeBranchEntries(entries: any[]): Array<{ id: string; text: string; tokens: number }> {
  const chunks: Array<{ id: string; text: string; tokens: number }> = [];

  for (const entry of entries) {
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
          } else if (block.type === "toolCall") {
            // pi-ai / pi-durable shape: { type: "toolCall", name, arguments }
            text += `\n[Tool call: ${block.name}(${JSON.stringify(block.arguments ?? {}).slice(0, 500)})]`;
          }
        }
      }
    } else if (role === "tool" || role === "toolResult") {
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

/**
 * Group serialized entries into chunks of at most `tokenLimit` tokens (an oversized entry gets a chunk of its own).
 * A chunk's `id` is its last entry's id, the watermark a caller records once the chunk is observed.
 */
export function chunkSerialized(
  serialized: Array<{ id: string; text: string; tokens: number }>,
  tokenLimit = 5000,
): Array<{ id: string; text: string; tokenCount: number }> {
  const chunks: Array<{ id: string; text: string; tokenCount: number }> = [];
  let text = "";
  let tokens = 0;
  let lastId = "";
  for (const entry of serialized) {
    if (tokens + entry.tokens > tokenLimit && text.length > 0) {
      chunks.push({ id: lastId, text, tokenCount: tokens });
      text = "";
      tokens = 0;
    }
    text += (text ? "\n\n" : "") + entry.text;
    tokens += entry.tokens;
    lastId = entry.id;
  }
  if (text.length > 0) chunks.push({ id: lastId, text, tokenCount: tokens });
  return chunks;
}
