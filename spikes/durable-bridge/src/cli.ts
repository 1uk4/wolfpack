/**
 * durable-bridge spike CLI.   node src/cli.ts <submit|attach|steer|abort|reconnect|tools|ask|all>
 * Each subcommand uses its own scratch sqlite under .scratch/ and writes evidence/*.json.
 */
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AgentDoc } from "@earendil-works/pi-durable";
import {
  createdConv, ctx, flat, freshStore, openRig, record, recToJson, rootConv, saveEvidence, sleep, summarize, finalTextOf, textOf, toolLog,
  type Recording,
} from "./lib.ts";

import { createRequire } from "node:module";
const T0 = Date.now();
console.log("pi-durable", createRequire(import.meta.url)("@earendil-works/pi-durable/package.json").version);
const log = (...a: unknown[]) => console.log(`[${String(Date.now() - T0).padStart(6)}ms]`, ...a);
const verdicts: Record<string, string> = {};

/** Collapse runs of message_update / tool_execution_update so timelines are readable. */
function timeline(r: Recording): string[] {
  const out: string[] = [];
  let run = 0, last = "";
  const flush = () => { if (run > 1) out[out.length - 1] += ` x${run}`; run = 0; };
  for (const b of r.batches) for (const e of b.events) {
    const s = e.type === "message_update" || e.type === "tool_execution_update" ? e.type : summarize(e);
    if (s === last) { run++; continue; }
    flush(); out.push(s); last = s; run = 1;
  }
  flush();
  return out;
}

const assistantTextsOf = (messages: readonly any[]) =>
  messages.filter((m) => m.role === "assistant").map((m) => m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(""));

// ---------------------------------------------------------------- 1 SUBMIT
async function submit() {
  log("== 1 SUBMIT ==");
  const rig = await openRig(freshStore("submit"));
  const out: any = {};
  for (const [label, mk] of [["root", rootConv], ["created", createdConv]] as const) {
    const conv = await mk(rig);
    const rec = await record(rig, conv, label);
    const sub = await conv.submit({ type: "input", content: "Write a 4-line poem about otters." }, ctx);
    log(label, "conv id", conv.id, "submission", sub.id, "status at admit:", (await sub.status(ctx)).status);
    const settled = await sub.wait(ctx);
    await sleep(100);
    const text = textOf(rec);
    log(label, "settled:", settled.status, "| streamed (start+deltas):", JSON.stringify(text), "| message_end text:", JSON.stringify(finalTextOf(rec)));
    log(label, "timeline:", timeline(rec).join(" > "));
    const deltas = flat(rec).filter((e: any) => e.type === "message_update").flatMap((e: any) => e.changes).filter((c: any) => c.type === "text_delta").length;
    out[label] = { conversationId: conv.id, submission: settled, text, textDeltaCount: deltas, timeline: timeline(rec), rec: recToJson(rec) };
    await rec.stop();
  }
  // Streaming is throttled (100ms partial commits): a fast reply may carry only the message_start partial and no
  // text_delta at all, so "streamed" = any partial text observed before message_end.
  const ok = [out.root, out.created].every((o) => o.text.length > 0 && o.submission.status === "done");
  verdicts["1 SUBMIT"] = ok ? "PASS" : "FAIL";
  saveEvidence("1-submit.json", out);
  await rig.close();
}

// ---------------------------------------------------------------- 2 ATTACH
async function attach() {
  log("== 2 STREAM/ATTACH ==");
  const rig = await openRig(freshStore("attach"));
  const conv = await rootConv(rig);
  const idle = await record(rig, conv, "idle-attach");
  log("idle snapshot keys:", Object.keys(idle.snapshot).join(","), "entries", idle.snapshot.entries.length);
  const a = await record(rig, conv, "clientA");
  const sub = await conv.submit({ type: "input", content: "First write a 10-line poem about otters, then call the slow tool with seconds=5, then say 'finished'." }, ctx);
  await a.waitFor((e) => e.type === "message_start" && (e as any).message.role === "assistant");
  const bGen = await record(rig, conv, "clientB-midgen");
  log("B(midgen) snapshot.generation:", JSON.stringify(bGen.snapshot.generation)?.slice(0, 300), "tools", bGen.snapshot.tools.length);
  await a.waitFor((e) => e.type === "tool_execution_start");
  await sleep(2500);
  const bTool = await record(rig, conv, "clientC-midtool");
  log("C(midtool) snapshot.tools:", JSON.stringify(bTool.snapshot.tools), "run:", JSON.stringify(bTool.snapshot.run), "inbox:", JSON.stringify(bTool.snapshot.inbox));
  await sub.wait(ctx);
  await sleep(200);
  const post = await record(rig, conv, "clientD-postturn");
  log("D(post-turn) snapshot: entries", post.snapshot.entries.length, "kinds", post.snapshot.entries.map((e) => e.kind).join(","), "run", JSON.stringify(post.snapshot.run), "tools", post.snapshot.tools.length);
  log("A timeline:", timeline(a).join(" > "));
  log("C timeline:", timeline(bTool).join(" > "));
  log("distinct event types seen by A:", [...new Set(flat(a).map((e) => e.type))].join(","));
  const seqs = rig.commits.map((c) => c.seq);
  log("commit seqs (subscribeCommits) first/last/count:", seqs[0], seqs.at(-1), seqs.length, "| non-+1 steps:", seqs.slice(1).map((s, i) => s - seqs[i]).filter((d) => d !== 1).length);
  const json = JSON.stringify([a.snapshot, ...flat(a)]);
  log("'seq' key present anywhere in snapshot/events JSON:", /"seq"/.test(json));
  const ok = bTool.snapshot.tools.some((t) => t.status === "running") && bGen.snapshot.entries.length >= 1;
  verdicts["2 STREAM/ATTACH"] = ok ? "PASS" : "FAIL";
  saveEvidence("2-attach.json", {
    note: "A attached before submit; B at first message_update (mid-generation); C mid-tool; D after the turn; idle = fresh conversation.",
    idle: recToJson(idle), clientA: recToJson(a), clientB_midGeneration: recToJson(bGen), clientC_midTool: recToJson(bTool), clientD_postTurn: recToJson(post),
    commits: rig.commits, seqExposedInEvents: /"seq"/.test(json),
  });
  for (const r of [idle, a, bGen, bTool, post]) await r.stop();
  await rig.close();
}

// ---------------------------------------------------------------- 3 STEER
async function steer() {
  log("== 3 STEER ==");
  const rig = await openRig(freshStore("steer"));
  const conv = await rootConv(rig);
  const rec = await record(rig, conv, "steer");
  const sub = await conv.submit({ type: "input", content: "Call the slow tool with seconds=4, then reply with the single word 'finished'." }, ctx);
  await rec.waitFor((e) => e.type === "tool_execution_start");
  await sleep(1000);
  const steerSub = await conv.submit({ type: "input", content: "STEERING: change of plan - your final reply must be exactly the word PINEAPPLE instead.", whenBusy: "steer" }, ctx);
  log("steer submission status at admit:", (await steerSub.status(ctx)).status);
  let defaultBehaviour = "";
  let dsub;
  try {
    dsub = await conv.submit({ type: "input", content: "(whenBusy omitted) After that, also say DONE2." }, ctx);
    defaultBehaviour = `accepted, status=${(await dsub.status(ctx)).status}`;
  } catch (e) { defaultBehaviour = `threw ${(e as Error).constructor.name}: ${(e as Error).message}`; }
  log("submit with whenBusy omitted while busy:", defaultBehaviour);
  let rejectBehaviour = "";
  try { await conv.submit({ type: "input", content: "x", whenBusy: "reject" }, ctx); rejectBehaviour = "accepted?!"; }
  catch (e) { rejectBehaviour = `threw ${(e as Error).constructor.name}`; }
  log("whenBusy reject while busy:", rejectBehaviour);
  const s1 = await sub.wait(ctx); const s2 = await steerSub.wait(ctx);
  const s3 = dsub ? await dsub.wait(ctx) : undefined;
  await conv.waitForIdle(ctx); await sleep(300);
  log("settled: original", s1.status, "| steer", s2.status, "| default", s3?.status);
  const view = await conv.context(ctx);
  log("transcript:", view.entries.map((e) => `${e.id}:${e.kind}`).join(" "));
  const texts = assistantTextsOf(view.messages);
  log("assistant texts:", JSON.stringify(texts));
  log("timeline:", timeline(rec).join(" > "));
  verdicts["3 STEER"] = texts.some((t) => /PINEAPPLE/i.test(t)) ? "PASS" : "FAIL";
  saveEvidence("3-steer.json", { defaultBehaviour, rejectBehaviour, settled: { original: s1, steer: s2, default: s3 }, assistantTexts: texts, transcript: view.entries.map((e) => ({ id: e.id, kind: e.kind })), rec: recToJson(rec) });
  await rec.stop(); await rig.close();
}

// ---------------------------------------------------------------- 4 ABORT
async function abort() {
  log("== 4 ABORT ==");
  const out: any = {};
  for (const phase of ["mid-tool", "mid-generation"] as const) {
    const rig = await openRig(freshStore(`abort-${phase}`));
    const conv = await rootConv(rig);
    const rec = await record(rig, conv, `abort-${phase}`);
    const prompt = phase === "mid-tool"
      ? "Call the slow tool with seconds=20, then say finished."
      : "Write the numbers from 1 to 400 separated by spaces, nothing else.";
    const sub = await conv.submit({ type: "input", content: prompt }, ctx);
    if (phase === "mid-tool") { await rec.waitFor((e) => e.type === "tool_execution_start"); await sleep(1500); }
    else { await rec.waitFor((e) => e.type === "message_update"); await sleep(400); }
    const tAbort = Date.now();
    await conv.abort(ctx);
    log(phase, `conv.abort() resolved after ${Date.now() - tAbort}ms`);
    await sleep(300);
    const sRec = await sub.status(ctx);
    const view = await conv.context(ctx);
    const insp = await rig.harness.inspect(ctx);
    const post = await record(rig, conv, "post-abort-snapshot");
    log(phase, "submission:", JSON.stringify(sRec));
    log(phase, "timeline:", timeline(rec).join(" > "));
    log(phase, "transcript:", view.entries.map((e) => `${e.id}:${e.kind}`).join(" "));
    const last = view.messages.at(-1) as any;
    log(phase, "last model message:", last?.role, last?.stopReason, JSON.stringify(last?.content)?.slice(0, 160), last?.errorMessage);
    log(phase, "inspect: live tasks", insp.tasks.length, "unsettled submissions", insp.submissions.length, "| post snapshot run:", JSON.stringify(post.snapshot.run), "tools:", post.snapshot.tools.length, "gen:", !!post.snapshot.generation);
    const sub2 = await conv.submit({ type: "input", content: "Reply with the single word OK." }, ctx);
    const r2 = await sub2.wait(ctx);
    log(phase, "follow-up turn after abort:", r2.status);
    out[phase] = { submission: sRec, followup: r2, timeline: timeline(rec), transcript: view.entries.map((e) => ({ id: e.id, kind: e.kind, model: e.model })), inspect: { tasks: insp.tasks.length, submissions: insp.submissions }, postSnapshot: post.snapshot, rec: recToJson(rec) };
    await post.stop(); await rec.stop(); await rig.close();
  }
  verdicts["4 ABORT"] = out["mid-tool"].followup.status === "done" && out["mid-generation"].followup.status === "done" ? "PASS" : "FAIL";
  saveEvidence("4-abort.json", out);
}

// ---------------------------------------------------------------- 5 RECONNECT
async function reconnect() {
  log("== 5 RECONNECT/REPLAY ==");
  const store = freshStore("reconnect");
  const replay = (process.env.SLOW_REPLAY as "safe" | "unsafe" | undefined) ?? "unsafe";
  const child = fork(fileURLToPath(import.meta.url), ["__child-turn", store, replay], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.stdout!.on("data", (d) => process.stdout.write(`   [child] ${d}`));
  child.stderr!.on("data", (d) => process.stderr.write(`   [child!] ${d}`));
  await new Promise<void>((res, rej) => { child.on("message", (m) => m === "mid-tool" && res()); child.on("exit", () => rej(new Error("child exited early"))); });
  await sleep(1500);
  log("SIGKILL child mid-tool");
  child.kill("SIGKILL");
  await new Promise((r) => child.on("exit", r));

  // Reopen WITHOUT resume to see raw post-crash state first.
  const rig = await openRig(store, { resume: false, slowReplay: replay });
  const conv = await rootConv(rig);
  const pre = await record(rig, conv, "post-crash-pre-resume");
  const insp0 = await rig.harness.inspect(ctx);
  log("post-crash snapshot (before resume): run", JSON.stringify(pre.snapshot.run), "tools", JSON.stringify(pre.snapshot.tools).slice(0, 300), "entries", pre.snapshot.entries.map((e) => `${e.id}:${e.kind}`).join(","));
  log("inspect():", insp0.tasks.map((t) => `${t.record.id}:${t.state.kind}`).join(" "), "| submissions", insp0.submissions.map((s) => `${s.id}:${s.status}`).join(","));
  await pre.stop();
  rig.harness.resume();
  const rec = await record(rig, conv, "post-resume");
  log("post-resume attach snapshot: run", JSON.stringify(rec.snapshot.run), "tools", JSON.stringify(rec.snapshot.tools).slice(0, 300));
  const t = Date.now();
  await conv.waitForIdle(ctx);
  await sleep(300);
  log("recovered turn idle after", Date.now() - t, "ms; slow replay =", replay);
  log("timeline after resume:", timeline(rec).join(" > "));
  log("tool executions in THIS (recovering) process:", toolLog.map((x) => x.name).join(",") || "(none)");
  const page = await conv.entries({ order: "ascending" }, 100, undefined, ctx);
  const ids = page.items.map((e) => e.id as number);
  const mono = ids.every((v, i) => i === 0 || v > ids[i - 1]!);
  log("entries ascending:", page.items.map((e) => `${e.id}:${e.kind}`).join(" "), "| strictly increasing:", mono, "| steps:", ids.slice(1).map((v, i) => v - ids[i]!).join(","));
  const seqs = rig.commits.map((c) => c.seq);
  log("commit seqs after reopen: first", seqs[0], "last", seqs.at(-1), "steps:", seqs.slice(1).map((s, i) => s - seqs[i]!).join(","));
  const fin = await record(rig, conv, "fresh-after-recovery");
  log("fresh attach after recovery: entries", fin.snapshot.entries.map((e) => `${e.id}:${e.kind}`).join(","), "run", JSON.stringify(fin.snapshot.run));
  const finIds = JSON.stringify(fin.snapshot.entries.map((e) => e.id));
  await fin.stop(); await rec.stop(); await rig.close();
  const rig1 = await openRig(store, { resume: false, slowReplay: replay });
  const again = await record(rig1, await rootConv(rig1), "reopen-2");
  const sameIds = JSON.stringify(again.snapshot.entries.map((e) => e.id)) === finIds;
  log("second reopen: snapshot entry ids identical:", sameIds, "| entries", again.snapshot.entries.length);
  await again.stop();
  verdicts["5 RECONNECT/REPLAY"] = mono && sameIds ? "PASS" : "FAIL";
  saveEvidence(`5-reconnect-${replay}.json`, {
    replay, postCrashSnapshot: pre.snapshot, postResume: recToJson(rec), entries: page.items.map((e) => ({ id: e.id, kind: e.kind })), commitSeqsAfterReopen: seqs,
    freshAfterRecoverySnapshot: fin.snapshot, sameIdsAcrossReopen: sameIds, inspectPostCrash: insp0.tasks.map((x) => ({ id: x.record.id, state: x.state.kind })),
  });
  await rig1.close();
}

async function childTurn(store: string, replay: "safe" | "unsafe") {
  const rig = await openRig(store, { slowReplay: replay });
  const conv = await rootConv(rig);
  const rec = await record(rig, conv, "child");
  await conv.submit({ type: "input", content: "Call the slow tool with seconds=6, then say 'finished'." }, ctx);
  await rec.waitFor((e) => e.type === "tool_execution_start");
  console.log("child: tool running");
  process.send!("mid-tool");
  await sleep(60_000);
}

// ---------------------------------------------------------------- 6 TOOLS
async function tools() {
  log("== 6 TOOLS ==");
  const rig = await openRig(freshStore("tools"));
  const conv = await rootConv(rig);
  const agent = await conv.agent(ctx);
  log("agent.tools offered:", agent.tools.map((t) => t.name).join(","), "| extensions:", agent.extensions.map((e) => e.name).join(","), "| deferred:", agent.deferred.length);
  const rec = await record(rig, conv, "tools");
  const sub = await conv.submit({ type: "input", content: "Use the add tool to compute 17+25, then use echo to repeat the result. Then tell me the result." }, ctx);
  await sub.wait(ctx); await sleep(200);
  log("tool calls executed:", toolLog.map((t) => `${t.name}(${JSON.stringify(t.args)})`).join(" "));
  log("timeline:", timeline(rec).join(" > "));
  const toolEnds = flat(rec).filter((e) => e.type === "tool_execution_end").length;
  const all = (await conv.agent(ctx)).tools;
  await conv.configure({ tools: all.filter((t) => t.name === "echo") }, ctx);
  log("configure({tools:[echo]}) -> offered", (await conv.agent(ctx)).tools.map((t) => t.name).join(","));
  await conv.configure({ tools: null, modelTools: all.filter((t) => t.name === "add") }, ctx);
  log("configure({tools:null, modelTools:[add]}) -> offered", (await conv.agent(ctx)).tools.map((t) => t.name).join(","));
  await conv.configure({ modelTools: null, extensions: [] }, ctx);
  log("configure({extensions:[]}) -> offered", (await conv.agent(ctx)).tools.map((t) => t.name).join(",") || "(none)");
  await conv.configure({ extensions: null, instructions: "Be terse.", cwd: "/tmp" }, ctx);
  const stored = await rig.harness.snapshot(AgentDoc, conv.id, ctx);
  log("stored pi.agent doc (names only, no objects):", JSON.stringify(stored));
  verdicts["6 TOOLS"] = toolLog.some((t) => t.name === "add") && toolEnds >= 1 ? "PASS" : "FAIL";
  saveEvidence("6-tools.json", { offered: agent.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, replay: (t as any).replay })), storedAgentDoc: stored, toolLog, rec: recToJson(rec) });
  await rec.stop(); await rig.close();
}

// ---------------------------------------------------------------- ASK (two-turn, control.terminate)
async function ask() {
  log("== 6b ASK / terminate (two-turn) ==");
  const rig = await openRig(freshStore("ask"));
  const conv = await rootConv(rig, { instructions: "When you need information from the user, call ask_user. After calling it, do not write anything else." });
  const rec = await record(rig, conv, "ask");
  const sub = await conv.submit({ type: "input", content: "I want to book a restaurant. Ask me what cuisine I want using the ask_user tool." }, ctx);
  const s1 = await sub.wait(ctx); await sleep(300);
  log("turn1 submission:", JSON.stringify(s1));
  log("turn1 timeline:", timeline(rec).join(" > "));
  const view = await conv.context(ctx);
  log("turn1 transcript:", view.entries.map((e) => `${e.id}:${e.kind}`).join(" "));
  const toolRes = view.entries.filter((e) => e.kind === "pi.tool-result").at(-1);
  log("tool-result entry data:", JSON.stringify(toolRes?.data));
  const insp = await rig.harness.inspect(ctx);
  const probe = await record(rig, conv, "idle-probe");
  log("idle after terminate: live tasks", insp.tasks.length, "| snapshot.run", JSON.stringify(probe.snapshot.run));
  await probe.stop();
  const sub2 = await conv.submit({ type: "input", content: "Italian." }, ctx);
  const s2 = await sub2.wait(ctx); await sleep(200);
  const texts = assistantTextsOf((await conv.context(ctx)).messages);
  log("turn2:", s2.status, "assistant texts:", JSON.stringify(texts));
  verdicts["6b ASK/terminate"] = s1.status === "done" && s2.status === "done" ? "PASS" : "FAIL";
  saveEvidence("6b-ask-terminate.json", { turn1: s1, turn2: s2, transcript: view.entries.map((e) => ({ id: e.id, kind: e.kind, data: e.data })), assistantTexts: texts, rec: recToJson(rec) });
  await rec.stop(); await rig.close();
}

// ---------------------------------------------------------------- sub (subscription provider, no tools)
async function sub() {
  log("== SUB: durable turn via claude-bridge (Agent SDK, subscription) ==");
  log("ANTHROPIC_API_KEY in env:", process.env.ANTHROPIC_API_KEY ? "PRESENT (abort)" : "absent");
  if (process.env.ANTHROPIC_API_KEY) { verdicts["SUB"] = "FAIL (key present)"; return; }
  const { mkdirSync } = await import("node:fs");
  const { NodeExecutionEnv } = await import("@earendil-works/pi-durable/env/node");
  const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const { createRegistry, Harness } = await import("@earendil-works/pi-durable");
  const { claudeBridgeProvider } = await import("./sdk-provider.ts");
  const { SCRATCH } = await import("./lib.ts");
  mkdirSync(SCRATCH, { recursive: true });
  const models = createModels();
  models.setProvider(claudeBridgeProvider());
  const harness = await Harness.open(
    await openNodeSqliteStorage(freshStore("sub")),
    { models, registry: createRegistry(), env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? SCRATCH }), onReport: (e) => console.error("[onReport]", e instanceof Error ? e.message : e) },
    ctx,
  );
  harness.resume();
  const conv = await harness.root(ctx, { agent: { model: { provider: "claude-bridge", modelId: "claude-haiku-5-5" }, thinkingLevel: null, instructions: "Be extremely terse." } });
  const rig = { harness } as any;
  const rec = await record(rig, conv, "sub");
  const s = await conv.submit({ type: "input", content: "In one sentence, what is an otter?" }, ctx);
  const settled = await s.wait(ctx);
  await sleep(200);
  log("settled:", settled.status);
  log("timeline:", timeline(rec).join(" > "));
  const final = finalTextOf(rec);
  const entry: any = (settled as any).answer;
  log("streamed:", JSON.stringify(textOf(rec)));
  log("FINAL TEXT:", JSON.stringify(final));
  log("assistant entry model/usage:", JSON.stringify(entry?.model?.[0] && { provider: entry.model[0].provider, model: entry.model[0].model, usage: entry.model[0].usage, stopReason: entry.model[0].stopReason }));
  const ok = settled.status === "done" && final.trim().length > 0;
  verdicts["SUB"] = ok ? "PASS" : "FAIL";
  console.log(ok ? "PASS: durable turn completed via claude-bridge with no ANTHROPIC_API_KEY" : "FAIL");
  saveEvidence("sub-subscription.json", { settled, final, timeline: timeline(rec), rec: recToJson(rec) });
  await rec.stop(); await harness.close(ctx);
}


// ---------------------------------------------------------------- gate (tool streaming through the SDK)
async function gate() {
  const mode = process.env.GATE_MODE ?? "park";
  const variant = process.env.GATE_VARIANT ?? "add"; // add | steer
  log(`== GATE (${mode}/${variant}): durable executes tool mid-turn, model on subscription ==`);
  if (process.env.ANTHROPIC_API_KEY) { verdicts["GATE"] = "FAIL (key present)"; return; }
  const { execSync } = await import("node:child_process");
  const { NodeExecutionEnv } = await import("@earendil-works/pi-durable/env/node");
  const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const { createRegistry, Harness } = await import("@earendil-works/pi-durable");
  const { claudeBridgeToolsProvider, stats, shutdown } = await import("./sdk-provider-tools.ts");
  const { makeTools, SCRATCH } = await import("./lib.ts");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(SCRATCH, { recursive: true });
  const models = createModels();
  models.setProvider(claudeBridgeToolsProvider());
  const registry = createRegistry();
  registry.install(makeTools());
  const harness = await Harness.open(
    await openNodeSqliteStorage(freshStore(`gate-${mode}-${variant}`)),
    { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? SCRATCH }), onReport: (e) => console.error("[onReport]", e instanceof Error ? e.message : e) },
    ctx,
  );
  harness.resume();
  const conv = await harness.root(ctx, { agent: { model: { provider: "claude-bridge", modelId: "claude-haiku-5-5" }, thinkingLevel: null, instructions: "Be extremely terse. Use tools when told." } });
  const all = (await conv.agent(ctx)).tools;
  await conv.configure({ modelTools: all.filter((t) => t.name === (variant === "steer" ? "slow" : "add")) }, ctx);
  log("tools offered to model:", (await conv.agent(ctx)).tools.map((t) => t.name).join(","));
  const rig = { harness } as any;
  const rec = await record(rig, conv, "gate");
  // sample child processes of this node process
  const pids = new Map<number, string>();
  const sampler = setInterval(() => {
    try { for (const l of execSync(`pgrep -P ${process.pid} -l`, { encoding: "utf8" }).split("\n").filter(Boolean)) { const [pid, ...n] = l.split(" "); pids.set(Number(pid), n.join(" ")); } } catch {}
  }, 100);
  const t0 = Date.now();
  const prompt = variant === "steer"
    ? "Call the slow tool with seconds=3, then reply with the single word 'finished'."
    : "Use the add tool to compute 17+25, then say the sum in words.";
  const s = await conv.submit({ type: "input", content: prompt }, ctx);
  let steerSub;
  if (variant === "steer") {
    await rec.waitFor((e) => e.type === "tool_execution_start");
    await sleep(500);
    steerSub = await conv.submit({ type: "input", content: "STEERING: change of plan - your final reply must be exactly the word PINEAPPLE instead.", whenBusy: "steer" }, ctx);
  }
  const settled = await s.wait(ctx);
  if (steerSub) await steerSub.wait(ctx);
  await conv.waitForIdle(ctx);
  await sleep(300);
  const totalMs = Date.now() - t0;
  clearInterval(sampler);
  const tl = timeline(rec);
  const view = await conv.context(ctx);
  const texts = assistantTextsOf(view.messages);
  const final = texts.at(-1) ?? "";
  log("settled:", settled.status, "total ms", totalMs);
  log("timeline:", tl.join(" > "));
  log("tool calls executed BY ENGINE:", toolLog.map((t) => `${t.name}(${JSON.stringify(t.args)})`).join(" "));
  log("assistant texts:", JSON.stringify(texts));
  log("transcript:", view.entries.map((e) => `${e.id}:${e.kind}`).join(" "));
  log("sdk queries spawned:", stats.queriesSpawned, "| distinct child pids seen:", [...pids.entries()].map(([p, n]) => `${p}`).join(","));
  log("rounds:", JSON.stringify(stats.rounds.map((r: any) => ({ path: r.path, ms: r.ms, stop: r.stop, usage: r.usage && { in: r.usage.input, out: r.usage.output, cr: r.usage.cacheRead, cw: r.usage.cacheWrite } }))));
  const starts = flat(rec).filter((e) => e.type === "tool_execution_start").length;
  const ends = flat(rec).filter((e) => e.type === "tool_execution_end").length;
  const executed = toolLog.some((t) => t.name === (variant === "steer" ? "slow" : "add"));
  const answerOk = variant === "steer" ? /PINEAPPLE/i.test(final) : /forty[- ]?two|42/i.test(final);
  const order = tl.findIndex((x) => x.startsWith("tool_execution_start")) < tl.findIndex((x) => x.startsWith("tool_execution_end"));
  const ok = settled.status === "done" && executed && starts >= 1 && ends >= 1 && order && answerOk;
  verdicts[`GATE ${mode}/${variant}`] = ok ? "PASS" : "FAIL";
  saveEvidence(`gate-${mode}-${variant}.json`, {
    mode, variant, prompt, settled, totalMs, finalText: final, assistantTexts: texts, timeline: tl, toolLog,
    sdk: { queriesSpawned: stats.queriesSpawned, childPidsSeen: pids.size, rounds: stats.rounds, lastRateLimit: (stats as any).lastRateLimit },
    transcript: view.entries.map((e) => ({ id: e.id, kind: e.kind, model: e.model })), rec: recToJson(rec),
  });
  await rec.stop(); shutdown(); await harness.close(ctx);
  try { log("leftover children:", execSync(`pgrep -P ${process.pid} -l || true`, { encoding: "utf8" }).trim() || "none"); } catch {}
}

// ---------------------------------------------------------------- main
const cmds: Record<string, () => Promise<void>> = { submit, attach, steer, abort, reconnect, tools, ask };
const extra: Record<string, () => Promise<void>> = { sub, gate };
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "__child-turn") {
  await childTurn(rest[0]!, rest[1] as "safe" | "unsafe");
} else if (cmd === "all") {
  for (const [k, f] of Object.entries(cmds)) { try { await f(); } catch (e) { verdicts[k] = `ERROR ${(e as Error).message}`; console.error(e); } }
  console.log("\nVERDICTS", verdicts); process.exit(0);
} else if (cmd && extra[cmd]) {
  await extra[cmd](); console.log("\nVERDICTS", verdicts); process.exit(0);
} else if (cmd && cmds[cmd]) {
  await cmds[cmd](); console.log("\nVERDICTS", verdicts); process.exit(0);
} else {
  console.log("usage: node src/cli.ts <submit|attach|steer|abort|reconnect|tools|ask|all>"); process.exit(1);
}
