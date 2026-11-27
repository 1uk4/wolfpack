/** A hub message for the state file, a log line or a reason: whitespace collapsed, at most `max` characters (ending in an ellipsis when cut). */
export function clip(msg: string, max = 300): string {
  const s = msg.replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}\u2026`;
}
