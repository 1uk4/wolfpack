/**
 * The read-only prompt catalog: every prompt the wolf side uses that a wolf cannot override, with where it lives, who uses it
 * and (for pipeline prompts) the output contract the reply is parsed against. Texts are read from the constants the running
 * build imports, never copied. Hub-only sweep prompts stay on the hub (hubd GET /v1/settings).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  CRAWL_CONSOLIDATE_SYSTEM,
  CRAWL_JOURNEY_SYSTEM,
  CRAWL_OBSERVER_SYSTEM,
  CONSOLIDATE_SYSTEM,
  DISTILL_GRADUATION,
  DISTILL_GRADUATION_STANDING,
  DISTILL_SYSTEM,
  OBSERVER_GENERAL_FLAG,
  OBSERVER_SYSTEM,
  WORK_COMPACT_SYSTEM,
  WORK_DISTILL_SYSTEM,
  WORK_LOG_SYSTEM,
  WORK_RECORD_SYSTEM,
  WORK_TIDY_SYSTEM,
} from "@wolfpack/engine";
import {
  ACTIVE_WORK_CONTEXT_HEADER,
  BREAKDOWN_SUGGESTION_SYSTEM,
  ConsolidationResultSchema,
  CRAWL_CONSOLIDATION_USER_PROMPT,
  CRAWL_JOURNEY_USER_PROMPT,
  CRAWL_OBSERVER_USER_PROMPT,
  CrawlTopicSchema,
  DistillOutputSchema,
  JourneyResultSchema,
  LIVE_OBSERVER_USER_PROMPT,
  ObserverResultSchema,
  PACK_ALREADY_KNOWS_RUNNING_DIGEST_TEMPLATE,
  SESSION_CONSOLIDATION_USER_PROMPT,
  STAGE_CONTEXT,
  SUCCESS_CRITERIA_LINE,
  TASK_SUMMARY_SYSTEM,
  TaskSummaryResult,
  WorkRecordSchema,
} from "@wolfpack/memory";
import type { PromptBlock } from "./context.js";
import { contractText } from "./zod-contract.js";

export type CatalogKind = "system-block" | "tool" | "pipeline" | "compaction";

export interface CatalogEntry {
  id: string;
  group: string;
  label: string;
  kind: CatalogKind;
  /** Which process or agent uses it. */
  user: string;
  scope: "wolf" | "global";
  /** Where the text lives. */
  file: string;
  text: string;
  /** Pipeline prompts: the JSON-schema-like shape the reply is parsed against. */
  contract?: string;
  /** The `{{name}}` placeholders the text declares. */
  placeholders: string[];
  /** Exported constant names behind the text (the source-scan guard checks every *_SYSTEM against these). */
  constants?: string[];
}

export interface ToolInfo {
  name: string;
  description: string;
  /** The extension that registers it. */
  extension?: string;
}

const MEMORY_PROMPTS = "packages/engine/src/config/prompts/memory.ts";
const ENGINE_PROMPTS = "packages/engine/src/prompts.ts";
const MEMORY_TEMPLATES = "packages/memory/src/config/prompts";

/** `{{name}}` placeholders in a text, sorted and unique. */
export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map((m) => m[1]!))].sort();
}

/**
 * pi-durable does not export its compaction prompts, so they are read from the installed package: dist/harness/compaction.js,
 * the `const SUMMARIZATION_SYSTEM_PROMPT = \`...\`` and `SUMMARIZATION_PROMPT` template literals. "(not found)" if a future
 * version renames or moves them.
 */
export function piDurableCompactionPrompts(): { system: string; instructions: string; file: string } {
  const NOT_FOUND = "(not found in the installed @earendil-works/pi-durable)";
  let file = "@earendil-works/pi-durable dist/harness/compaction.js";
  let src = "";
  try {
    const entry = createRequire(import.meta.url).resolve("@earendil-works/pi-durable");
    const path = join(dirname(entry), "harness", "compaction.js");
    src = readFileSync(path, "utf8");
    // Show the package and version, not the pnpm store path.
    let version = "";
    try {
      version = `@${(JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8")) as { version?: string }).version ?? ""}`;
    } catch {
      // no package.json beside dist
    }
    file = `@earendil-works/pi-durable${version} dist/harness/compaction.js`;
  } catch {
    // leave src empty
  }
  const grab = (name: string): string => {
    const m = new RegExp(`const ${name} = \`([\\s\\S]*?)\`;\\n`).exec(src);
    return m ? m[1]!.replace(/\\`/g, "`").replace(/\\\\/g, "\\") : NOT_FOUND;
  };
  return { system: grab("SUMMARIZATION_SYSTEM_PROMPT"), instructions: grab("SUMMARIZATION_PROMPT"), file };
}

function pipeline(
  id: string,
  group: string,
  label: string,
  user: string,
  file: string,
  text: string,
  extra: { schema?: unknown; contractNote?: string; constants: string[]; placeholders?: string[] },
): CatalogEntry {
  const contract = extra.schema ? contractText(extra.schema) : extra.contractNote;
  return { id: `pipeline.${id}`, group, label, kind: "pipeline", user, scope: "global", file, text, ...(contract ? { contract } : {}), placeholders: extra.placeholders ?? placeholdersOf(text), constants: extra.constants };
}

const LINES_NOTE = "Reply is an object with a lines array, parsed by the work-memory parser; no shared schema.";

function pipelineEntries(): CatalogEntry[] {
  const OBS = "Memory pipeline (observer, per wolf)";
  const CON = "Memory pipeline (consolidation, per wolf)";
  const CRAWL = "Crawl (knowledge ingest)";
  const stages = Object.entries(STAGE_CONTEXT).map(([stage, text]) =>
    pipeline(`stage-context.${stage}`, "Work context", `Stage context: ${stage}`, "main wolf and subagents bound to a work item (memory extension)", `${MEMORY_TEMPLATES}/tasks.ts`, text, { constants: ["STAGE_CONTEXT"] }),
  );
  return [
    pipeline("observer", "Memory observation", "Observer system prompt (live conversations)", OBS, MEMORY_PROMPTS, OBSERVER_SYSTEM, { schema: ObserverResultSchema, constants: ["OBSERVER_SYSTEM", "OBSERVER_GENERAL_FLAG"] }),
    pipeline("observer-user", "Memory observation", "Observer user template (live)", OBS, `${MEMORY_TEMPLATES}/observations.ts`, LIVE_OBSERVER_USER_PROMPT, { schema: ObserverResultSchema, constants: ["LIVE_OBSERVER_USER_PROMPT"] }),
    pipeline("consolidate", "Memory consolidation", "Consolidation system prompt", CON, MEMORY_PROMPTS, CONSOLIDATE_SYSTEM, { schema: ConsolidationResultSchema, constants: ["CONSOLIDATE_SYSTEM"] }),
    pipeline("consolidate-user", "Memory consolidation", "Session consolidation user template", CON, `${MEMORY_TEMPLATES}/consolidations.ts`, SESSION_CONSOLIDATION_USER_PROMPT, { schema: ConsolidationResultSchema, constants: ["SESSION_CONSOLIDATION_USER_PROMPT"] }),
    pipeline("pack-digest", "Memory consolidation", "Running digest block (what the pack already knows)", CON, `${MEMORY_TEMPLATES}/consolidations.ts`, PACK_ALREADY_KNOWS_RUNNING_DIGEST_TEMPLATE, { constants: ["PACK_ALREADY_KNOWS_RUNNING_DIGEST_TEMPLATE"] }),
    pipeline("crawl-observer", "Crawl", "Crawl observer system prompt (documents)", CRAWL, MEMORY_PROMPTS, CRAWL_OBSERVER_SYSTEM, { schema: ObserverResultSchema, constants: ["CRAWL_OBSERVER_SYSTEM"] }),
    pipeline("crawl-observer-user", "Crawl", "Crawl observer user template", CRAWL, `${MEMORY_TEMPLATES}/observations.ts`, CRAWL_OBSERVER_USER_PROMPT, { schema: ObserverResultSchema, constants: ["CRAWL_OBSERVER_USER_PROMPT"] }),
    pipeline("crawl-consolidate", "Crawl", "Crawl consolidation system prompt", CRAWL, MEMORY_PROMPTS, CRAWL_CONSOLIDATE_SYSTEM, { schema: CrawlTopicSchema, constants: ["CRAWL_CONSOLIDATE_SYSTEM"] }),
    pipeline("crawl-consolidate-user", "Crawl", "Crawl consolidation user template", CRAWL, `${MEMORY_TEMPLATES}/consolidations.ts`, CRAWL_CONSOLIDATION_USER_PROMPT, { schema: CrawlTopicSchema, constants: ["CRAWL_CONSOLIDATION_USER_PROMPT"] }),
    pipeline("crawl-journey", "Crawl", "Crawl journey (history) system prompt", CRAWL, MEMORY_PROMPTS, CRAWL_JOURNEY_SYSTEM, { schema: JourneyResultSchema, constants: ["CRAWL_JOURNEY_SYSTEM"] }),
    pipeline("crawl-journey-user", "Crawl", "Crawl journey user template", CRAWL, `${MEMORY_TEMPLATES}/consolidations.ts`, CRAWL_JOURNEY_USER_PROMPT, { schema: JourneyResultSchema, constants: ["CRAWL_JOURNEY_USER_PROMPT"] }),
    pipeline("distill", "KB promotion", "Distill: den topic to KB contribution", "Promote (memory extension, wolf side)", ENGINE_PROMPTS, DISTILL_SYSTEM, { schema: DistillOutputSchema, constants: ["DISTILL_SYSTEM"] }),
    pipeline("distill-graduation", "KB promotion", "Distill: graduation of a finished work item (appended)", "Graduation (wolf side)", ENGINE_PROMPTS, DISTILL_GRADUATION, { schema: DistillOutputSchema, constants: ["DISTILL_GRADUATION"] }),
    pipeline("distill-graduation-standing", "KB promotion", "Distill: standing feature (appended)", "Graduation (wolf side)", ENGINE_PROMPTS, DISTILL_GRADUATION_STANDING, { schema: DistillOutputSchema, constants: ["DISTILL_GRADUATION_STANDING"] }),
    pipeline("work-record", "Work memory", "Work record: rewrite a work item's Record", "Work-record consolidation (memory extension)", ENGINE_PROMPTS, WORK_RECORD_SYSTEM, { schema: WorkRecordSchema, constants: ["WORK_RECORD_SYSTEM"] }),
    pipeline("work-log", "Work memory", "Work log: lines a task adds from new observations", "Work log (memory extension)", ENGINE_PROMPTS, WORK_LOG_SYSTEM, { constants: ["WORK_LOG_SYSTEM"], contractNote: LINES_NOTE }),
    pipeline("work-compact", "Work memory", "Work compact: shrink a log that hit its size cap", "Work log compaction (memory extension)", ENGINE_PROMPTS, WORK_COMPACT_SYSTEM, { constants: ["WORK_COMPACT_SYSTEM"], contractNote: LINES_NOTE }),
    pipeline("work-distill", "Work memory", "Work distill: shipped task log into the feature Record", "Ship distill (memory extension)", ENGINE_PROMPTS, WORK_DISTILL_SYSTEM, { constants: ["WORK_DISTILL_SYSTEM"], contractNote: LINES_NOTE }),
    pipeline("work-tidy", "Work memory", "Work tidy: one-time tidy of a finished feature's Record", "Final pass (memory extension)", "packages/engine/src/work-tidy.ts", WORK_TIDY_SYSTEM, { constants: ["WORK_TIDY_SYSTEM"], contractNote: LINES_NOTE }),
    pipeline("task-summary", "Work memory", "Task summary on completion", "Work memory (task done)", `${MEMORY_TEMPLATES}/tasks.ts`, TASK_SUMMARY_SYSTEM, { schema: TaskSummaryResult, constants: ["TASK_SUMMARY_SYSTEM"] }),
    pipeline("breakdown-suggestion", "Work memory", "Breakdown suggestion (child tasks or features)", "Work memory (defined; no engine.call site uses it yet)", `${MEMORY_TEMPLATES}/tasks.ts`, BREAKDOWN_SUGGESTION_SYSTEM, { constants: ["BREAKDOWN_SUGGESTION_SYSTEM"], contractNote: "No call site parses a reply against a schema yet." }),
    pipeline("active-work-header", "Work context", "Active work context header", "main wolf and subagents bound to a work item (memory extension)", `${MEMORY_TEMPLATES}/tasks.ts`, ACTIVE_WORK_CONTEXT_HEADER, { constants: ["ACTIVE_WORK_CONTEXT_HEADER"] }),
    pipeline("success-criteria-line", "Work context", "Success criteria line", "main wolf and subagents bound to a work item (memory extension)", `${MEMORY_TEMPLATES}/tasks.ts`, SUCCESS_CRITERIA_LINE, { constants: ["SUCCESS_CRITERIA_LINE"] }),
    ...stages,
  ];
}

/** Everything read-only the wolf shows: its system-prompt blocks and tools (built at start-up), then the static pipeline and compaction prompts. */
export function readOnlyCatalog(input: { blocks: readonly PromptBlock[]; tools: readonly ToolInfo[] }): CatalogEntry[] {
  const blocks = input.blocks.map(
    (b): CatalogEntry => ({ id: `system.${b.id}`, group: "System prompt", label: b.label, kind: "system-block", user: "main wolf (home and feature threads)", scope: "wolf", file: b.source, text: b.text, placeholders: placeholdersOf(b.text) }),
  );
  const tools = input.tools.map(
    (t): CatalogEntry => ({ id: `tool.${t.name}`, group: "Tool descriptions", label: t.name, kind: "tool", user: "main wolf (offered to the model)", scope: "wolf", file: t.extension ? `extension ${t.extension}` : "wolfd", text: t.description, placeholders: placeholdersOf(t.description) }),
  );
  const pd = piDurableCompactionPrompts();
  const compaction: CatalogEntry[] = [
    { id: "compaction.pi-durable-system", group: "Compaction", label: "Wolf thread compaction: summarizer system prompt", kind: "compaction", user: "wolfd (pi-durable), every wolf's threads, automatic and manual", scope: "global", file: `${pd.file} SUMMARIZATION_SYSTEM_PROMPT`, text: pd.system, placeholders: placeholdersOf(pd.system) },
    { id: "compaction.pi-durable-instructions", group: "Compaction", label: "Wolf thread compaction: summary instructions", kind: "compaction", user: "wolfd (pi-durable), every wolf's threads, automatic and manual", scope: "global", file: `${pd.file} SUMMARIZATION_PROMPT`, text: pd.instructions, placeholders: placeholdersOf(pd.instructions) },
  ];
  return [...blocks, ...tools, ...pipelineEntries(), ...compaction];
}
