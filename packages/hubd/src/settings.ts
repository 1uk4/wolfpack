/**
 * GET /v1/settings: what hubd runs with. Read-only.
 *
 *   prompts  every engine prompt the hub's KB sweep (curator.ts -> kb runSweepTick) passes to engine.call, read from the
 *            @wolfpack/engine constants the running build imports, raw (placeholders untouched).
 *   config   the effective options as loaded, with secrets masked.
 *   version  this package's version.
 */
import { readFileSync } from "node:fs";
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
import type { HubPrompt, HubSettings } from "@wolfpack/protocol";

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

/** Option names that hold a credential (key, token, secret, password, ...). */
const SECRET_KEY = /token|secret|passw(or)?d|passphrase|credential|api[-_]?key|bearer|private[-_]?key|cookie/i;
/** A URL with userinfo (`https://user:pw@host`) is a credential too. */
const URL_WITH_USERINFO = /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]*@/i;

/** Copy `value` with every secret replaced by `{ set: boolean }`; functions and undefined are dropped (test seams, absent options). */
export function maskSecrets(value: unknown, key = ""): unknown {
  if (typeof value === "function" || value === undefined) return undefined;
  if (key && SECRET_KEY.test(key) && (value === null || typeof value !== "object")) return { set: value !== null && value !== "" && value !== false };
  if (typeof value === "string" && URL_WITH_USERINFO.test(value)) return { set: true };
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k) && v && typeof v === "object" && !Array.isArray(v)) { out[k] = { set: true }; continue; }
      const m = maskSecrets(v, k);
      if (m !== undefined) out[k] = m;
    }
    return out;
  }
  return value;
}

let cachedVersion: string | undefined;
/** The hubd package version (package.json next to src/ and dist/). */
export function hubVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const v = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version;
    cachedVersion = v ?? "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}

export function buildHubSettings(config: Record<string, unknown>): HubSettings {
  return { version: hubVersion(), prompts: hubPrompts(), config: maskSecrets(config) as Record<string, unknown> };
}
