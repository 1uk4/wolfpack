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
  ConsolidationResultSchema,
  CRAWL_CONSOLIDATION_USER_PROMPT,
  CRAWL_JOURNEY_USER_PROMPT,
  CRAWL_OBSERVER_USER_PROMPT,
  CrawlTopicSchema,
  GRADUATION_RULES,
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
import { checkReadOnlyCommand, checkWorkerCommand } from "@wolfpack/agents";
import type { AgentDefinition } from "@wolfpack/agents";
import { CONTINUE_PROMPT, DROPPED_CALL_MESSAGE, EMPTY_ACK_MESSAGE, EMPTY_ACK_NUDGE } from "../providers/dropped-call.js";
import { ANSWER_ANSWERED, ANSWER_SKIPPED, ANSWER_SUBMITTED, REVISE_NOT_APPLIED, subAgentHead } from "../injected-text.js";
import type { PromptBlock } from "./context.js";
import { childInstructions } from "./subagents.js";
import { describeChange } from "./task-notice.js";
import { contractText } from "./zod-contract.js";

export type CatalogKind = "system-block" | "tool" | "pipeline" | "compaction" | "request-section" | "delivery";

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
    pipeline("active-work-header", "Work context", "Active work context header", "main wolf and subagents bound to a work item (memory extension)", `${MEMORY_TEMPLATES}/tasks.ts`, ACTIVE_WORK_CONTEXT_HEADER, { constants: ["ACTIVE_WORK_CONTEXT_HEADER"] }),
    pipeline("success-criteria-line", "Work context", "Success criteria line", "main wolf and subagents bound to a work item (memory extension)", `${MEMORY_TEMPLATES}/tasks.ts`, SUCCESS_CRITERIA_LINE, { constants: ["SUCCESS_CRITERIA_LINE"] }),
    ...stages,
  ];
}

/**
 * Sections wolfd re-renders on EVERY request (extension `sections`), after the start-up blocks. Their text depends on the wolf's
 * den, KB and binding, so each entry is a TEMPLATE: the shape the model sees with `<angle>` slots (sample data, not a live
 * render). The static lines follow the source named in `file`; change the source first, then here.
 */
function requestSectionEntries(): CatalogEntry[] {
  const user = "main wolf, every request (extension section, re-rendered per request)";
  const sec = (id: string, label: string, file: string, text: string): CatalogEntry => ({ id: `request.${id}`, group: "Per-request sections", label, kind: "request-section", user, scope: "wolf", file, text, placeholders: placeholdersOf(text) });
  return [
    sec("wolf_memory", "wolf_memory: den topics not yet in the KB (template)", "packages/memory/src/prompt-context.ts renderDenContext", [
      "Wolf <wolf>'s den topics not yet in the shared KB (<count>), in <den>/memory/topics/:",
      "- <topic>.md [<status>] -- <summary>",
      "Read a topic file when you need its details. Everything else lives in the KB.",
    ].join("\n")),
    sec("wolf_memory_retired", "wolf_memory_retired: notes now in the KB (template)", "packages/memory/src/prompt-context.ts renderRetiredContext", [
      "Notes this wolf kept locally were moved into the shared KB (read them with kb_access):",
      "- <entry title> (<entry id>): <entry summary>",
    ].join("\n")),
    sec("kb_access", "kb_access: subscribed domains and their section trees (template)", "packages/memory/src/prompt-context.ts renderKbAccess", [
      "You have access to <n> shared knowledge domain(s):",
      "- <domain> (<entries> entries):",
      "  - <Section title> (<entries in subtree>) — <section summary>",
      "    - <child section> (<entries>) — <summary>",
      "(N) = entries in that section. Each domain lives at <kb mirror>/domains/<domain>/. Entry ids are in <domain>/_digest.json; browse INDEX.md; read entries/<id>.md on demand.",
    ].join("\n")),
    sec("task_tools", "task_tools: task tool list, domains and work-id rule (template)", "extensions/wolfpack-memory/unified-tasks.ts section task_tools", [
      "## Task Tools",
      "Available: task_query, task_bind, task_claim, task_release, task_unbind, task_create, task_done, task_note, task_stage, task_graduate",
      "Domains: <domain list>",
      "Work item IDs: always write the full `work-<domain>-<id>` ... (rule about chips and code blocks)",
      "<binding rules, omitted for subagents and read-only task conversations>",
    ].join("\n\n")),
    sec("task_tools_graduation", "task_tools: graduation rules (the Graduation block, real text)", "packages/memory/src/work/binding.ts GRADUATION_RULES (rendered in task_tools by extensions/wolfpack-memory/unified-tasks.ts, not for subagents)", GRADUATION_RULES),
    sec("active_task", "active_task: the bound work item (template)", "extensions/wolfpack-memory/unified-tasks.ts section active_task", [
      "## Active Task",
      "<unbound: the 'item completed' notice once, then the unbound context and: Use `task_query` to see available work.>",
      "<bound: the stable header (id, title, kind, parent feature, success criteria). Stage, counts and the Record are left out on purpose: they arrive as the Task update notice and via task_query {current: true}.>",
      "Empty for subagents.",
    ].join("\n\n")),
    sec("telegram-suffix", "Telegram suffix (terminal pi only; wolfd does not load it)", "extensions/wolfpack-telegram/index.ts SYSTEM_PROMPT_SUFFIX", [
      "Telegram bridge extension is active.",
      '- Messages forwarded from Telegram are prefixed with "[telegram]".',
      "- [telegram] messages may include local temp file paths for Telegram attachments. Read those files as needed.",
      "- If a [telegram] user asked for a file or generated artifact, use the telegram_attach tool ...",
    ].join("\n")),
  ];
}

/**
 * Text wolfd and the harness write themselves and the model reads: user-role deliveries, nudges, the child's instructions and guard
 * refusals. Built from the real exported constants and functions where the source exports them; the rest are templates (`<slots>`).
 */
function deliveryEntries(): CatalogEntry[] {
  const group = "Injected messages, nudges and guards";
  const del = (id: string, label: string, user: string, file: string, text: string): CatalogEntry => ({ id: `delivery.${id}`, group, label, kind: "delivery", user, scope: "wolf", file, text, placeholders: placeholdersOf(text) });
  const profile = { body: "<the profile's prompt (agent .md body)>" } as unknown as AgentDefinition;
  const worktree = { ws: { path: "<worktree path>", branch: "<branch>", repo: { mainDir: "<main checkout>", toplevel: "<main checkout>" } }, offLimits: ["<main checkout>", "<feature worktree>"] };
  const guard = (r: string | null): string => r ?? "(not blocked)";
  const SUB = "packages/harness/src/wolfd/subagents.ts";
  const DROP = "packages/harness/src/providers/dropped-call.ts";
  return [
    del("task-notice", "Task update notice (one line before the next user message)", "main wolf; written by wolfd, no model call", "packages/harness/src/wolfd/task-notice.ts describeChange",
      describeChange({ workId: "<id>", stage: "in_build", record: "a" }, { workId: "<id>", stage: "shipped", record: "b" })),
    del("ask-answer-submitted", "Ask answer: submitted", "main wolf; a card answer becomes this user-role message", "packages/harness/src/wolfd/cards.ts", `${ANSWER_SUBMITTED}<tool> questionnaire (call <call id>), <n> pages:\n<page title, each question and its answer>`),
    del("ask-answer-answered", "Ask answer: single question answered", "main wolf", "packages/harness/src/wolfd/cards.ts", `${ANSWER_ANSWERED}<tool> question (call <call id>):\n<the answer>`),
    del("ask-answer-skipped", "Ask answer: skipped", "main wolf", "packages/harness/src/wolfd/cards.ts", `${ANSWER_SKIPPED}<tool> question (call <call id>).`),
    del("ask-revise-not-applied", "Ask revise: not applied note", "main wolf", "packages/harness/src/wolfd/cards.ts", `${REVISE_NOT_APPLIED}: <reason>`),
    del("subagent-completed", "Sub-agent delivery: completed", "parent thread; steer message", SUB, `${subAgentHead("<name>", "completed")}<elapsed>).\n\n<the child's last message>\n\n[delivery <id>]`),
    del("subagent-failed", "Sub-agent delivery: failed", "parent thread; steer message", SUB, `${subAgentHead("<name>", "failed")}<elapsed>: <why>.\n\nYou can resume the session with subagent_message.\n\n[delivery <id>]`),
    del("subagent-asks", "Sub-agent delivery: asks the parent", "parent thread; steer message", SUB, `${subAgentHead("<name>", "asks")}<elapsed>):\n\n<question>\n\nReply with subagent_message({ name: "<name>", message: "…" }) — the same name works whether it is still running or has since exited. It stays open until you reply.\n\n[delivery <id>]`),
    del("subagent-stopped", "Sub-agent delivery: stopped by the operator", "parent thread; steer message", SUB, `${subAgentHead("<name>", "stopped")}.\n\nFollow up with subagent_message({ name: "<name>", message: "…" }) to resume it.\n\n[delivery <id>]`),
    del("subagent-child-instructions", "Sub-agent child instructions (profile body, worktree note, role line)", "every sub-agent thread", `${SUB} childInstructions`, childInstructions(profile, "<name>", worktree as never)),
    del("continue-prompt", "Continue prompt (sent after every tool-result round)", "every model round after a tool result (claude bridge)", `${DROP} CONTINUE_PROMPT`, CONTINUE_PROMPT),
    del("empty-ack-nudge", "Empty-acknowledgement nudge (appended on retry)", "retry after an empty reply", `${DROP} EMPTY_ACK_NUDGE`, EMPTY_ACK_NUDGE),
    del("dropped-call-message", "Dropped tool call error shown to the owner", "shown, not sent to a model", `${DROP} DROPPED_CALL_MESSAGE`, DROPPED_CALL_MESSAGE),
    del("empty-ack-message", "Empty acknowledgement error shown to the owner", "shown, not sent to a model", `${DROP} EMPTY_ACK_MESSAGE`, EMPTY_ACK_MESSAGE),
    del("guard-read-only", "Command guard refusal: read-only agents (sample: `rm -rf x`)", "read-only agents' bash tool result", "packages/agents/src/command-guard.ts block", guard(checkReadOnlyCommand("rm -rf x"))),
    del("guard-worker", "Command guard refusal: worker git lockdown (sample: `git push`)", "worker agents' bash tool result", "packages/agents/src/command-guard.ts checkWorkerCommand", guard(checkWorkerCommand("git push"))),
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
  return [...blocks, ...requestSectionEntries(), ...tools, ...deliveryEntries(), ...pipelineEntries(), ...compaction];
}
