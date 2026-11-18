/** `hubd rebuild preview|apply|restore|list`: calls the running hub's operator-only rebuild routes on localhost. Mints a short-lived console token in the data dir (the way `hubd pair` does) and revokes it afterwards. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hubdPort } from "@wolfpack/protocol/runtime-home";
import { createTokenStore } from "./auth.js";

export interface RebuildCliArgs {
  sub: "preview" | "apply" | "restore" | "list";
  dataDir: string;
  port: number;
  domain?: string;
  plan?: string;
  stamp?: string;
  wait: boolean;
  flags: { from: "current" | "scratch"; applyCrossMoves: boolean; approvedCrossMoves: string[]; allowCollapse: boolean; allowKmeansFallback: boolean };
  /** apply: also send these flags, so a plan made with others is refused. */
  expectFlags: boolean;
}

export const REBUILD_USAGE = `hubd rebuild preview <domain> --data-dir <dir> [--port 3142] [--wait] [--from-scratch] [--allow-collapse] [--apply-cross-moves | --approve-move <entryId>...] [--allow-kmeans-fallback]
hubd rebuild apply <planId> --data-dir <dir> [--port 3142] [--expect-flags + the same flags]   applies exactly that plan under the hub's KB lock; no model calls; hubd keeps running
hubd rebuild restore <domain> <stamp> --data-dir <dir> [--port 3142]                          one command back to the state before an apply
hubd rebuild list --data-dir <dir> [--port 3142]                                               plans, preview jobs and restore points`;

export function parseRebuildArgs(rest: string[]): RebuildCliArgs {
  const sub = rest[0];
  if (sub !== "preview" && sub !== "apply" && sub !== "restore" && sub !== "list") throw new Error(`rebuild needs preview, apply, restore or list\n${REBUILD_USAGE}`);
  const out: RebuildCliArgs = { sub, dataDir: "", port: 3142, wait: false, expectFlags: false, flags: { from: "current", applyCrossMoves: false, approvedCrossMoves: [], allowCollapse: false, allowKmeansFallback: false } };
  const pos: string[] = [];
  for (let i = 1; i < rest.length; i++) {
    const f = rest[i]!;
    const val = () => { const v = rest[++i]; if (v === undefined || v.startsWith("--")) throw new Error(`${f} needs a value`); return v; };
    if (f === "--data-dir") out.dataDir = val();
    else if (f === "--port") { const p = Number(val()); if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error("--port must be an integer from 1 to 65535"); out.port = p; }
    else if (f === "--wait") out.wait = true;
    else if (f === "--expect-flags") out.expectFlags = true;
    else if (f === "--from-scratch") out.flags.from = "scratch";
    else if (f === "--from-current") out.flags.from = "current";
    else if (f === "--allow-collapse") out.flags.allowCollapse = true;
    else if (f === "--allow-kmeans-fallback") out.flags.allowKmeansFallback = true;
    else if (f === "--apply-cross-moves") out.flags.applyCrossMoves = true;
    else if (f === "--approve-move") out.flags.approvedCrossMoves.push(val());
    else if (f.startsWith("--")) throw new Error(`rebuild does not take ${f}\n${REBUILD_USAGE}`);
    else pos.push(f);
  }
  if (!out.dataDir) throw new Error("rebuild requires --data-dir");
  // apply given any flag option: send them as the expected flags, so a plan made with others is refused (no flags: apply whatever the plan holds)
  if (sub === "apply" && rest.some((f) => ["--from-scratch", "--from-current", "--allow-collapse", "--allow-kmeans-fallback", "--apply-cross-moves", "--approve-move"].includes(f))) out.expectFlags = true;
  if (out.flags.applyCrossMoves && out.flags.approvedCrossMoves.length) throw new Error("--apply-cross-moves (all) and --approve-move (selected) cannot be combined");
  if (sub === "preview") { if (pos.length !== 1) throw new Error("rebuild preview needs one <domain>"); out.domain = pos[0]; }
  if (sub === "apply") { if (pos.length !== 1) throw new Error("rebuild apply needs one <planId>"); out.plan = pos[0]; }
  if (sub === "restore") { if (pos.length !== 2) throw new Error("rebuild restore needs <domain> <stamp>"); [out.domain, out.stamp] = pos as [string, string]; }
  if (sub === "list" && pos.length) throw new Error("rebuild list takes no arguments");
  return out;
}

/** The top of the plan's .md (the Engine: line and any WARNING lines), so a fallback is seen before approving. The CLI runs on the hub host, so the file is read directly. */
function engineSummary(dataDir: string, planId: string): string {
  try {
    const lines = readFileSync(join(dataDir, "rebuild-plans", `${planId}.md`), "utf-8").split("\n").filter((l) => l.startsWith("WARNING:") || l.startsWith("Engine:"));
    return lines.length ? `${lines.join("\n")}\n` : "";
  } catch { return ""; }
}

export async function runRebuildCli(a: RebuildCliArgs, log: (m: string) => void = console.log): Promise<void> {
  const store = createTokenStore(a.dataDir);
  const { token, tokenId } = store.redeem(store.mintPairingCode({ kind: "console" }).code, "hubd rebuild (temporary)", "console");
  const base = `http://127.0.0.1:${a.port}`;
  const call = async (method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> => {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      } catch (e) {
        // a hub busy planning can drop a connection now and then: retry before giving up
        if (attempt < 5) { await new Promise((r) => setTimeout(r, 1000)); continue; }
        throw new Error(`cannot reach hubd at ${base} (${e instanceof Error ? `${e.message}${e.cause ? `: ${String(e.cause)}` : ""}` : e}); is it running, and is --port right?`);
      }
      if (res.status === 401 && attempt < 10) { await new Promise((r) => setTimeout(r, 500)); continue; } // the running hub picks up the new token file within a moment
      const text = await res.text();
      if (!res.ok) throw new Error(`hubd answered ${res.status}: ${text.slice(0, 500)}`);
      return JSON.parse(text);
    }
  };
  // A Ctrl-C or kill must not leave the temporary console token valid. The hub reads the token file on a watch, so a fresh token can
  // answer 401 for a moment (the 401 retry above waits up to 5 s for it). Tokens have no expiry of their own (only the pairing code does).
  const onSignal = () => { try { store.revoke(tokenId); } catch { /* best effort */ } process.exit(130); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    if (a.sub === "list") {
      const r = (await call("GET", "/v1/admin/kb/rebuild/plans")) as { plans: Array<{ planId: string; createdAt: string; sections: number; entries: number }>; jobs: Array<{ jobId: string; domain: string; state: string; planId?: string; error?: string }>; backups: string[] };
      for (const p of r.plans) log(`plan    ${p.planId}  ${p.sections} sections, ${p.entries} entries  ${p.createdAt}`);
      for (const j of r.jobs) log(`job     ${j.jobId}  ${j.domain}  ${j.state}${j.planId ? `  → ${j.planId}` : ""}${j.error ? `  ${j.error}` : ""}`);
      for (const b of r.backups) log(`restore ${b}`);
      if (!r.plans.length && !r.jobs.length && !r.backups.length) log("nothing yet");
    } else if (a.sub === "preview") {
      const { jobId } = (await call("POST", "/v1/admin/kb/rebuild/preview", { domain: a.domain, flags: a.flags })) as { jobId: string };
      log(`preview started: job ${jobId}`);
      if (!a.wait) return void log("poll with `hubd rebuild list` (add --wait to block)");
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const r = (await call("GET", "/v1/admin/kb/rebuild/plans")) as { jobs: Array<{ jobId: string; state: string; planId?: string; error?: string }> };
        const j = r.jobs.find((x) => x.jobId === jobId);
        if (j?.state === "failed") throw new Error(`preview failed: ${j.error}`);
        if (j?.state === "done") return void log(`plan ${j.planId}  (proposal: <data-dir>/rebuild-plans/${j.planId}.md)\n${engineSummary(a.dataDir, j.planId!)}apply with: hubd rebuild apply ${j.planId} --data-dir ${a.dataDir}${a.port !== hubdPort(process.env, 3142) ? ` --port ${a.port}` : ""}`);
      }
    } else if (a.sub === "apply") {
      const r = (await call("POST", "/v1/admin/kb/rebuild/apply", { planId: a.plan, ...(a.expectFlags ? { expectFlags: a.flags } : {}) })) as { domain: string; stamp: string; entriesWritten: number; sections: number };
      log(`applied ${a.plan}: ${r.entriesWritten} entry file(s) rewritten, ${r.sections} section(s) in ${r.domain}\nrestore with: hubd rebuild restore ${r.domain} ${r.stamp} --data-dir ${a.dataDir}${a.port !== hubdPort(process.env, 3142) ? ` --port ${a.port}` : ""}`);
    } else {
      const r = (await call("POST", "/v1/admin/kb/rebuild/restore", { domain: a.domain, stamp: a.stamp })) as { entriesRestored: number; sections: number };
      log(`restored ${a.domain} from ${a.stamp}: ${r.entriesRestored} entry file(s) rewritten, ${r.sections} section(s)`);
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    store.revoke(tokenId);
  }
}
