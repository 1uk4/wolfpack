/**
 * Stream local wolves' pi session files into the main-context stat. Reads the
 * live files, not the ledger. Main vs subagent follows the same rule as usage
 * ingest (a subagent registry or launch script names the session).
 */
import fs from "node:fs";
import readline from "node:readline";
import { newAccumulator, addEntry, summarize, type ContextEntry, type ContextReport } from "./context.js";
import { listSources, type CollectOptions } from "./collect.js";

async function streamInto(file: string, acc: ReturnType<typeof newAccumulator>, since?: Date): Promise<void> {
  const rl = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"toolCall"') && !line.includes('"role":"toolResult"')) continue;
    let entry: ContextEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    addEntry(acc, entry, since);
  }
}

export async function collectContext(opts: CollectOptions, since?: Date): Promise<ContextReport> {
  const main = newAccumulator();
  const sub = newAccumulator();
  for (const src of listSources(opts).sources) {
    if (src.kind !== "pi") continue;
    // A file untouched since `since` can't hold entries in the window.
    if (since) {
      try {
        if (fs.statSync(src.file).mtimeMs < since.getTime()) continue;
      } catch {
        continue;
      }
    }
    const acc = (src.use ?? "main").startsWith("subagent") ? sub : main;
    try {
      await streamInto(src.file, acc, since);
      acc.sessions++;
    } catch {
      /* unreadable file */
    }
  }
  return { since: since?.toISOString(), main: summarize(main), subagent: summarize(sub) };
}
