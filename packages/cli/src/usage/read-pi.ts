/**
 * Usage from a local wolf's pi session files (<agent>/sessions/**\/*.jsonl).
 * Every assistant message with usage is one model call — including ones on
 * abandoned branches, which were real calls too. Subagent sessions live in
 * the same folders; the artifacts/<id>/subagent-registry.json files name them.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { UsageEvent } from "@wolfpack/engine";
import { eventFromMessage, type PiAssistantMessage } from "./message.js";

export interface SessionFiles {
  files: string[];
  /** Session files a subagent registry lists. */
  subagent: Set<string>;
  /** Agent name per subagent session file, where a launch script names it. */
  agents: Map<string, string>;
}

/** Every session .jsonl under a sessions dir, skipping artifacts/ (whose registries mark subagents). */
export function findSessionFiles(sessionsDir: string): SessionFiles {
  const files: string[] = [];
  const subagent = new Set<string>();
  const agents = new Map<string, string>();
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (d.name === "artifacts") {
          readRegistries(p, subagent);
          readLaunchScripts(p, agents);
        }
        else walk(p);
      } else if (d.isFile() && d.name.endsWith(".jsonl")) {
        files.push(p);
      }
    }
  };
  walk(sessionsDir);
  return { files: files.sort(), subagent, agents };
}

function readRegistries(artifactsDir: string, into: Set<string>): void {
  let runs: string[];
  try {
    runs = fs.readdirSync(artifactsDir);
  } catch {
    return;
  }
  for (const run of runs) {
    try {
      const reg = JSON.parse(fs.readFileSync(path.join(artifactsDir, run, "subagent-registry.json"), "utf8")) as Record<
        string,
        { sessionFile?: unknown }
      >;
      for (const v of Object.values(reg)) {
        if (typeof v?.sessionFile === "string") into.add(path.resolve(v.sessionFile));
      }
    } catch {
      /* no registry in this run */
    }
  }
}

/**
 * Launch scripts (artifacts/<run>/subagent-scripts/*.sh) carry the session
 * file (`# Session: <path>`) and the agent (`PI_SUBAGENT_AGENT='<name>'`).
 */
function readLaunchScripts(artifactsDir: string, into: Map<string, string>): void {
  let runs: string[];
  try {
    runs = fs.readdirSync(artifactsDir);
  } catch {
    return;
  }
  for (const run of runs) {
    const dir = path.join(artifactsDir, run, "subagent-scripts");
    let scripts: string[];
    try {
      scripts = fs.readdirSync(dir).filter((f) => f.endsWith(".sh"));
    } catch {
      continue;
    }
    for (const f of scripts) {
      try {
        const text = fs.readFileSync(path.join(dir, f), "utf8");
        const session = text.match(/^# Session: (.+)$/m)?.[1];
        const agent = text.match(/PI_SUBAGENT_AGENT='?([A-Za-z0-9_.-]+)'?/)?.[1];
        if (session && agent) into.set(path.resolve(session.trim()), agent);
      } catch {
        /* unreadable script */
      }
    }
  }
}

/** The usage `use` of a session file: main, subagent, or subagent:<agent>. */
export function sessionUse(file: string, sf: SessionFiles): string {
  const p = path.resolve(file);
  const agent = sf.agents.get(p);
  if (agent) return `subagent:${agent}`;
  return sf.subagent.has(p) ? "subagent" : "main";
}

/**
 * Stream one session file. Each event's id is `pi:<session id>:<entry id>`
 * (the file name stands in for a session without a header).
 */
export async function readPiSessionFile(file: string, wolf: string, use: string): Promise<UsageEvent[]> {
  const out: UsageEvent[] = [];
  let session: string | undefined;
  const rl = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (session === undefined && line.includes('"type":"session"')) {
      try {
        const h = JSON.parse(line) as { type?: string; id?: string };
        if (h.type === "session" && typeof h.id === "string") session = h.id;
      } catch {
        /* torn header */
      }
      continue;
    }
    if (!line.includes('"role":"assistant"') || !line.includes('"usage"')) continue;
    let entry: { type?: string; id?: string; timestamp?: string; message?: PiAssistantMessage };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const sid = session ?? path.basename(file, ".jsonl");
    const id = typeof entry.id === "string" ? `pi:${sid}:${entry.id}` : undefined;
    const e = eventFromMessage(entry.message, { id, wolf, source: "pi", session, use, ts: entry.timestamp });
    if (e) out.push(e);
  }
  return out;
}
