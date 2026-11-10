/**
 * GET /v1/settings: what hubd runs with. Read-only.
 *
 *   prompts  every engine prompt the hub's KB sweep (curator.ts -> kb runSweepTick) passes to engine.call, read from the
 *            @wolfpack/engine constants the running build imports, raw (placeholders untouched).
 *   config   the effective options as loaded, with secrets masked.
 *   version  this package's version.
 */
import { stampedVersion } from "@wolfpack/protocol/health-lag";
import {
  CONFIRM_SUBJECT_SYSTEM,
  CONTRADICT_SYSTEM,
  LABEL_SECTION_SYSTEM,
  MATCH_SUBJECT_SYSTEM,
  PRODUCE_SYSTEM,
  SECTION_PICK_SYSTEM,
  SECTION_SUMMARY_SYSTEM,
  SPLIT_SECTION_SYSTEM,
} from "@wolfpack/engine";
import { maskSecrets, type HubPrompt, type HubSettings } from "@wolfpack/protocol";

export { maskSecrets };

const GROUP = "KB sweep";

/** The prompts of the sweep path: kb/src/librarian oracles.ts, produce.ts and summarize.ts. A test fails when one is added there and not here. */
export function hubPrompts(): HubPrompt[] {
  return [
    { id: "sweep.produce", group: GROUP, label: "Write the entry (produce)", text: PRODUCE_SYSTEM },
    { id: "sweep.contradict", group: GROUP, label: "Contradiction check", text: CONTRADICT_SYSTEM },
    { id: "sweep.section-pick", group: GROUP, label: "Pick the section", text: SECTION_PICK_SYSTEM },
    { id: "sweep.match-subject", group: GROUP, label: "Match the subject", text: MATCH_SUBJECT_SYSTEM },
    { id: "sweep.confirm-subject", group: GROUP, label: "Confirm the subject", text: CONFIRM_SUBJECT_SYSTEM },
    { id: "sweep.section-summary", group: GROUP, label: "Section summary", text: SECTION_SUMMARY_SYSTEM },
    { id: "sweep.label-section", group: GROUP, label: "Section label", text: LABEL_SECTION_SYSTEM },
    { id: "sweep.split-section", group: GROUP, label: "Split an oversized section", text: SPLIT_SECTION_SYSTEM },
  ];
}

let cachedVersion: string | undefined;
/**
 * The hubd release version: the VERSION stamp next to the bundle (hubd.mjs) or the package root (packages/hubd/VERSION, written by
 * `pnpm runtime:update`), else `<package.json version>-dev`. See @wolfpack/protocol/health-lag stampedVersion.
 */
export function hubVersion(): string {
  cachedVersion ??= stampedVersion([new URL("./VERSION", import.meta.url), new URL("../VERSION", import.meta.url)], new URL("../package.json", import.meta.url)) ?? "unknown";
  return cachedVersion;
}

export function buildHubSettings(config: Record<string, unknown>): HubSettings {
  return { version: hubVersion(), prompts: hubPrompts(), config: maskSecrets(config) as Record<string, unknown> };
}
