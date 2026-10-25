# Durable bridge spike — FINDINGS

Spike `work-wolfpack-nPeM4M7`. Risk-retirement for an SSE/HTTP bridge over **raw `@earendil-works/pi-durable`**, headless, no daemon, no wolfpack extensions, no WORK_*/den/KB. Bare engine, model `claude-haiku-5-5` via pi-ai's `anthropic` provider.

**Result: behaviours 1–6 all PASS, on both 1.3.0 and 1.4.0 (observable behaviour identical).** All numbers below are from real runs; raw captures are in `evidence/` (1.4.0) and `evidence-1.3.0/` (baseline).

## How to run

```
cd spikes/durable-bridge
npm install --workspaces=false      # pins pi-durable 1.4.0 + pi-ai/chord 1.4.0 + typebox locally
node src/cli.ts submit|attach|steer|abort|reconnect|tools|ask|all     # needs ANTHROPIC_API_KEY (or ~/.wolfpack/.env; only that key is read)
SLOW_REPLAY=safe node src/cli.ts reconnect                            # replay:"safe" variant
npx tsc -p .                                                           # typecheck
```

- Standalone: outside `workspaces` (`packages/*`, `apps/*`), outside turbo and root tsconfig references; has its own `node_modules` + lockfile. Root `package-lock.json` and `packages/harness` are untouched (the harness still resolves 1.3.0 — upgrade is a separate ticket). `npm run verify` is unaffected.
- Runs TypeScript with Node 22's built-in type stripping (`node src/cli.ts`, no build step). `.scratch/` (sqlite stores, logs) is gitignored.
- Source: `src/lib.ts` (rig, recorder, sanitizer, test tools), `src/cli.ts` (one subcommand per behaviour).
- Each scenario uses a fresh sqlite under `.scratch/`; the crash test forks a child and `SIGKILL`s it mid-tool.
- `node:sqlite` prints an ExperimentalWarning on Node 22; harmless.

## Three findings that shape the protocol

1. **There are no event ids and no replay in `watchEvents`. Reconnect = fresh `snapshot` + live deltas, always.** Nothing in the snapshot or any event carries the commit `Seq` (verified: the string `"seq"` appears nowhere in captured snapshot/event JSON). Seq is only observable via `harness.subscribeCommits()` and does *not* map 1:1 to event batches (37 commits → 29 batches in one run; commits that change nothing agent-visible produce no batch). So **Last-Event-ID resume must be implemented by the bridge**, not the engine. Cheap design: bridge assigns its own per-conversation monotonic SSE `id` to each batch it forwards; keep a small in-memory ring; on reconnect with a `Last-Event-ID` still in the ring, replay from there; otherwise (or if the bridge restarted) send a fresh `snapshot` event. Snapshots are small (0.3–4.5 KB for a short turn) so "always snapshot on reconnect" is a viable v1. Clients dedupe by entry id (stable, see below).
2. **The stream is lossy-by-design in the middle, authoritative at the ends.** Partial-text commits are throttled (`progress.partialIntervalMs`, default 100 ms), so a fast reply may produce *zero* `text_delta` — the text arrives in `message_start.message` (the partial so far) plus deltas, and the **tail only appears in `message_end.entry`** (real runs: streamed text ended mid-sentence; `message_end` held the full answer). A bridge must treat `message_end`/`tool_execution_end`/`entry_appended` as truth and `message_update` as best-effort cosmetics. Also: `watchEvents` can deliver a **`snapshot` mid-stream** (source: overflow replaces undelivered batches with one snapshot; consumer >~100 batches behind) — clients must handle `snapshot` as "replace local state", not only as the first event.
3. **Ask-pattern works cleanly via `control: { terminate: true }`, and tool config is names-in-the-store / objects-in-the-process.** A tool returning `terminate` ends the run with no further model call; the next `submit()` continues the same conversation (see §6b). Per-wolf tool surface = `registry.install(defineExtension({name, tools}))` in-process + `conversation.configure({extensions, tools, modelTools, ...})`, which persists only *names* in `pi.agent`. So the engine layer owns the registry; the console/bridge can only select by name.

Also load-bearing: **`watchEvents` is officially EXPERIMENTAL** ("may change without notice", spec §9.4). The engine interface must fully wrap it (own event type, own snapshot type); no pi-durable type may leak into the bridge/wire protocol.

## 1. SUBMIT — PASS

- `harness.root(ctx, {agent})` and `harness.createConversation({ownership:{kind:"ownerless"}, agent}, ctx)` both work. Root id is the reserved `1`; the created conversation got id `12` (ids are one global counter — see Ids).
- `conv.submit({type:"input", content})` returns a `Submission` immediately; status at admit is `placed` when idle (`queued` when busy). `sub.wait(ctx)` → `{status:"done", entry:<user entry>, answer:<assistant entry>}`.
- Event order for a plain turn: `message_start(user) message_end(pi.user) submission(placed) run_start turn_start message_start(system) message_end(pi.system) message_start(assistant) [message_update…] message_end(pi.assistant) turn_end run_end submission(done) usage_changed`.
- Note the **`pi.system` entry** appended on the first turn: carries the rendered prompt `sections` and `toolsAdded` (full tool definitions). It is part of the transcript the snapshot returns; a UI should hide it.
- Streaming caveat → finding 2. The verdict criterion is "partial text observed before `message_end`", because a fast reply can have no `text_delta`.
- Gotcha: **the pi-durable main agent needs an API key** (`transport: api`). The local `models.json` is `transport: subscription` (Claude Agent SDK), which pi-durable cannot use (same TODO as `packages/harness/src/index.ts`). The spike read `ANTHROPIC_API_KEY` from `~/.wolfpack/.env` only.

## 2. STREAM/ATTACH — PASS

`watchEvents(harness, conversationId, ctx)` → `{snapshot, start(listener), stop(), closed}`. The snapshot is captured atomically with listener registration on the Session line, so no gap/dup between snapshot and first delta. `listener(events[], ctx)` receives **batches (one per commit that produced events)**; a batch can hold several events (observed 1–6).

### Snapshot contract (`SnapshotEvent`, type `"snapshot"`)

| field | meaning | observed |
|---|---|---|
| `entries` | **active transcript** entries as full `EntryRecord`s (`id, conversationId, kind, model[], data, byTaskId`) | `[]` fresh; `[user, system]` mid-generation; `[user, system, assistant, tool-result]` mid-tool; 6 entries post-turn |
| `run?` | `{inputs: SubmissionId[]}` — present exactly while busy | `{inputs:[8]}` mid-turn, absent idle |
| `generation?` | `{attempt, message?: AssistantMessage partial, retry?, deferred?}` — in-flight answer | mid-gen: `message.content[0].text="Ot"` (partial so far), `stopReason:"pending"` |
| `tools[]` | `ToolSlot`: `{callId,name,taskId?,status:"pending"\|"running"\|"done",output?,droppedBytes?,details?,diagnostics?,entry?}` | mid-tool: `slow` `running`, `output:"tick 1/5\ntick 2/5\n"`, `details:{tick:2,of:5}`; sibling `echo` `done` with `entry:14` |
| `nestedTools[]`, `compactions[]`, `compactionFailure?` | nested tool calls / compaction status | empty in this spike |
| `inbox[]` | queued `{id, mode:"steer"\|"followUp"}` | empty unless busy with queued input |
| `agent` | stored `AgentState` (names only) | `{model, instructions}` |
| `usage` | `{models:{…}, tools:{…}}` | |

So a mid-tool joiner gets live tool output and details already folded into the snapshot (late join works; `output` keeps a bounded window).

### Delta events (`AgentEvent`) after the snapshot

`run_start/run_end{inputs}`, `turn_start/turn_end`, `message_start{message}` (assistant message carries the **partial so far**), `message_update{usage, changes[]}` with `changes` ∈ `text_start|thinking_start|toolcall_start{contentIndex,block}`, `text_delta|thinking_delta{contentIndex,delta}`, `toolcall_delta{contentIndex,path,delta}`, `block`, `message` — deltas are relative to the *previous committed partial*, not to the whole text; `message_end{entry}` (final entry, authoritative); `tool_execution_start{toolCallId,toolName,taskId,args}`; `tool_execution_update{output?:{append\|trimStart\|set},details?,diagnostics?}` (first update after start carried `output.set`, later ones `append`; `details` arrives as its own batch); `tool_execution_end{entry}`; `inbox_update{items}`; `submission{record}`; `usage_changed`; plus `entry_appended`, `agent_changed`, `auto_retry_*`, `deferred_poll`, `task_failed`, `compaction_start/end` (not triggered here).
Captured types in a tool turn: `message_start, message_end, submission, run_start, turn_start, message_update, usage_changed, tool_execution_start/update/end, turn_end, run_end`.

Parallel tool rounds interleave: two tool calls in one assistant message produce two `tool_execution_start`s; results land in separate `pi.tool-result` entries.

Evidence: `evidence/2-attach.json` (idle / early A / mid-generation B / mid-tool C / post-turn D snapshots with their following batches, plus `commits`).

## 3. STEER — PASS

- `submit({type:"input", content, whenBusy:"steer"})` while busy returns `status:"queued"`; events: `submission(queued)` + `inbox_update(steer)`.
- It is **not injected mid-tool**. It is placed at the next boundary — right after the running tool round finishes: `tool_execution_end → pi.tool-result → pi.user(steer) → turn_end → submission(placed) → turn_start → assistant`. The model then answered `PINEAPPLE` as instructed (the original ask was "reply finished"). Transcript: `user, system, assistant(tool call), tool-result, user(steer), assistant "PINEAPPLE"`.
- **Spelling in 1.3.0 and 1.4.0 `.d.ts` is `"steer" | "followUp" | "reject"`** (camelCase `followUp`, not `follow-up`), also `QueueMode`/inbox `mode`. If the hyphenated form is used, TypeScript rejects it.
- **Default when `whenBusy` is omitted = `followUp`** (verified: queued, `inbox_update(steer,followUp)`; answered after the first run ended as a separate run, or merged into the following reply). `"reject"` throws `ConversationBusy` and writes nothing.
- Steer modes are `one-at-a-time` by default (`steeringMode`/`followUpMode` settings). Steer submissions can be withdrawn while queued via `submission.abort()` (status `aborted`) — not exercised.
- Protocol implication: the UI can show a queued chip from `inbox`/`inbox_update` and flip it on `submission(placed)`.

## 4. ABORT — PASS

`conversation.abort(ctx)`: withdraws queued inputs, marks and signals the ordinary-scope tasks, resolves when idle (722 ms mid-tool because the tool task must unwind; 5–19 ms mid-generation).

- **Mid-tool**: `tool_execution_end` still fires, with a *synthesized* error result keeping partial output: `content:[“tick 1/20”, “<harness>[error] Tool slow was aborted</harness>”]`, then `pi.tool-result` entry, `turn_end`, `run_end`, `submission(unanswered)` with `reason:"aborted"`.
- **Mid-generation**: the partial is committed as a normal `pi.assistant` entry with `stopReason:"aborted"` (visible in `entries()` / transcript, **excluded from the model context** — the next request's last message is the user message). No dedicated "aborted" event: a client sees `message_end` (entry stopReason `aborted`) → `turn_end` → `run_end` → `submission(unanswered, reason:"aborted")`.
- Post-state: `harness.inspect()` shows 0 live tasks / 0 unsettled submissions; fresh snapshot has no `run`, `generation` or `tools`. The conversation is immediately reusable (follow-up turn completed `done` in both phases).
- Bridge mapping: abort is `conv.abort()`; the client learns it from `submission.status==="unanswered" && reason==="aborted"` in the stream, not from a distinct event.

## 5. RECONNECT/REPLAY — PASS (with semantics the protocol must own)

Procedure: forked child opens the store, starts a turn with the 6 s `slow` tool, parent `SIGKILL`s it ~1.5 s in, then reopens the same `session.sqlite`.

- **Post-crash, before `resume()`**: attach snapshot is *stale-but-consistent*: `run:{inputs:[8]}`, tool slot still `status:"running"` with the last committed `output:"tick 1/6\n"`, entries `[user, system, assistant]`. `harness.inspect()` lists the tool task `ready`, the run task `waiting`, submission `placed`. Nothing signals "this process is not actually running it": liveness must come from the bridge (resume called or not).
- **After `harness.resume()`** the same run continues without any client action:
  - tool `replay:"unsafe"` (default): **not re-executed**; the harness writes an error tool result (`isError:true`, partial output kept, diagnostic code `interrupted`, “Tool slow was interrupted and may have partially run”), and the model continues from there (turn finished in ~1 s).
  - tool `replay:"safe"`: **re-executed from scratch** in the new process (full 6 s; new `tool_execution_update`s); result entry replaces the slot.
  - A watcher attached after reopen sees the continuation as normal deltas (`tool_execution_end → … → run_end → submission(done)`).
  - This means **every wolf tool needs an explicit `replay` classification**; the default (`unsafe`) turns a crash into an `interrupted` error result, which the model sees.
- **Ids** (`ids.d.ts`, observed): entry, task, submission, document ids all come from **one global monotonic counter in the store** (entries 7,10,11,13,15; submission 8; tasks 9,12; created conversation 12). Strictly increasing, **gaps are normal and expected** (steps 3,1,2,2 in one run). Stable across reopen: entry ids identical on every reopen (verified twice). Never reused.
- **Commit `Seq`** (`CommitPublication.seq`, from `harness.subscribeCommits`): per-store (whole Session, all conversations), strictly increasing, doc says gaps permitted; observed contiguous (steps all 1). Continues across process restarts rather than restarting at 1 (first seq seen after reopen was 12, in both replay variants) — persisted, not reset; I did not read the child's last seq directly. **Not present in `watchEvents` snapshot or events.**
- **History replay**: `conv.entries({order:"ascending"}, limit, cursor, ctx)` pages the full history (fork-aware); the attach snapshot only contains the *active* transcript (`ContextView.entries`: from the latest head marker — after reset/compaction, older entries are not in the snapshot; compaction/reset not exercised here).
- **What a bridge needs for Last-Event-ID**: (a) per-conversation counter + bounded ring of recent *forwarded batches* (they are in-memory only; engine keeps none); (b) on `Last-Event-ID` hit → replay the tail; (c) on miss/restart → emit a `snapshot`, with the snapshot given the bridge's *current* id. Because entries are immutable with stable ids and `message_end` is authoritative, a client can safely discard and rebuild from any snapshot. If cross-restart resume of ids is wanted, derive the counter from something persisted (e.g. commit seq via `subscribeCommits`, tagging each batch with the latest seen seq — approximate, since batches↔commits is not 1:1), or declare ids invalid after a bridge restart (snapshot is the answer).
- Untested (follow-ups): two processes opening the same sqlite concurrently; the >~100-batch overflow snapshot (read in `events.js`, not provoked); the 1.4.0 restart-limit parking (`settings.restartLimit`, default 5) — would show as `blocked/restart_limit` in `inspect()` and needs `harness.retryTask()`.

## 6. TOOLS — PASS

Tools registered and called by the model: `add(17,25)` → `echo("42")`, then the answer. Surface (all verified against `.d.ts`; behaviours confirmed by running):

- **Define**: `defineTool({name, description, parameters: Type.Object(…typebox), execute(args, api, ctx), replay?, executionMode?, callers?, deferred?, outputLimits?, prepareArguments?, structuredOutputSchema?})`. `execute` returns `{output?: content[], details?, isError?, diagnostics?, usage?, control?, structuredOutput?}`. **`output` (not `content`) is what the model sees** — returning `content` yields an empty result (the wolfpack adapter already special-cases this: `toDurableResult`).
- **Register**: `createRegistry()` then `registry.install(defineExtension({name, tools, sections?, hooks?, wraps?, tasks?}))`. `CodingTools` (`@earendil-works/pi-durable/tools`) is itself such an extension (read/write/edit/bash). Registry is **in-process**, application-owned; `install()` can replace by name and publishes live.
- **`ToolExecutionApi`** passed to `execute`: `output(chunk)` (live output, becomes snapshot `tools[].output`), `details(value, ctx)` (live details), `diagnostic()`, `memo()`, `commit()`, `createTask()`, `executeTool()` (nested calls), `agent()`, `env`, `models`, `conversationId`, `taskId`, `callId`, plus (1.4.0) `now()`.
- **Per-conversation selection** is `conversation.configure(change, ctx)` with `AgentChange`: `model`, `thinkingLevel`, `instructions`, `cwd`, `extensions` (array = exactly these; `{add,remove}` = edit the host default), `tools` (filter of enabled tools; `{remove}` allowed), `modelTools` (filter of what the *model* is offered; deferred tools only via `add`/array). Verified: `configure({tools:[echo]})` → model offered `echo` only; `{tools:null, modelTools:[add]}` → `add` only; `{extensions:[]}` → none. **Stored doc `pi.agent` holds names only** (`{"model":{…},"instructions":"Be terse.","cwd":"/tmp"}`): conversations reference extensions/tools by name, the registry must provide them at every process start. Missing definitions → task blocks (`missing_task`), not a crash.
- **Replay flag** per tool (`replay: "safe"|"unsafe"`, default `unsafe`) — see §5. `executionMode: "parallel"|"sequential"` per tool (a single sequential call makes the whole round sequential; default from `settings.toolExecution`, `"parallel"`).
- **`callers`** (`["model"]`, `["tools"]`, both): who may call (model vs nested `executeTool`). **`deferred: true`**: hidden from the model until loaded via `control.addTools` (tool_search pattern) — not exercised.
- **Per-wolf tool configuration = the engine's job**: map wolf config → which extensions installed in the registry + a `configure()` at conversation creation/start (`extensions`/`tools`/`modelTools`). Limits: no cross-process tool distribution, no per-tool auth/permission model beyond `callers`, hooks (`beforeTool` can `block`) are the only gate. There is no way to add a tool at runtime to *one* conversation except by installing a (possibly differently named) extension and selecting it by name.
- Gotcha: tool descriptions/parameters are frozen into the `pi.system` entry (`toolsAdded`) on first use and shown in the transcript.

### 6b. Two-turn ask pattern (`control: {terminate: true}`) — PASS, no blockers

`ask_user` tool returns `{output:[…], details:{pendingQuestion}, control:{terminate:true}}`.
- Turn 1: `assistant(tool call) → tool_execution_start/end → pi.tool-result → turn_end → run_end → submission(done)`. **No second model call**, no assistant text after the tool. `submission.answer` is the *tool-calling assistant entry* (id 11).
- After: 0 live tasks, snapshot has no `run`. The conversation is plain idle.
- Turn 2: a normal `submit("Italian.")` continues the same transcript; the model used the answer.
- Where the pending marker lives: `entry.model[0].details` of the `pi.tool-result` entry (and `tool_execution_end.entry`) — **not** `entry.data` (which only holds `{diagnostics}`). A bridge detects a pending question from the `tool_execution_end` for the `ask_user` tool name (or `details.pendingQuestion`) and the run ending; nothing in the engine tracks "pending" state, so the console must remember it (derive from transcript on reconnect: last entry is an `ask_user` tool-result with no later `pi.user`).
- 1.4.0: `terminate` is typed `boolean` (was `true`); per `.d.ts` the run ends only when **every** result of the round sets it to `true` (`false` is a no-op) — mixed rounds not exercised.

## Ids / seq summary

| thing | scope | monotonic | gaps | stable across reopen | exposed in watchEvents |
|---|---|---|---|---|---|
| entry / task / submission / document / conversation ids | one global counter per store | yes | yes (shared counter) | yes | entry ids, submission ids, task ids yes |
| commit `Seq` | per store (all conversations) | yes | permitted (none seen) | yes (continues) | **no** (only `subscribeCommits`) |
| watchEvents batch | per watch, in-memory | — | — | — | **no id, no replay** |

## 1.3.0 → 1.4.0 delta (owner policy: track latest stable; spike runs on 1.4.0)

- **Observable behaviour: no difference** in any of the 7 scenarios (event types/order, snapshot shape, steer/abort/reconnect/replay semantics, tool config, terminate). `events.d.ts` and `live.d.ts` are byte-identical across versions. Raw 1.3.0 captures kept in `evidence-1.3.0/`.
- API changes confirmed in the `.d.ts` diff: `ToolControl.terminate?: boolean` (was `true`); `HarnessOptions.models` may be a function, `settings` may be a function; new `telemetry`, `identity` (default pi attribution headers! `DEFAULT_HARNESS_IDENTITY`; pass `{attribution:null}` to suppress), `setTimer`, `onWake`/`Harness.wake()`, `now`; `onReport(error, info)` now has `info` (`session_failed`/`task_faulted`/`task_parked`); `HarnessSettings.restartLimit` (default 5) + `Harness.retryTask()`; `afterFailedRun: keep|continue|withdraw`; per-model `compaction.modelOverrides`; `TaskInspection` gains `sleeping` and blocked reason `restart_limit`; `ToolExecutionApi.now()`; sqlite schema v2 (scratch stores created fresh; upgrading a real `session.sqlite` is irreversible); new peer `@earendil-works/pi-telemetry`.
- The harness upgrade (packages/harness, root lockfile) is not done here; this spike's `package-lock.json` is separate.

## Implications for the SSE bridge (summary)

| Need | Mechanism |
|---|---|
| Subscribe | one `watchEvents` per (conversation, bridge process), fanned out to N SSE clients; first frame to each client = snapshot |
| Event id | **bridge-assigned**, per conversation, monotonic; ring buffer for `Last-Event-ID`; miss ⇒ new snapshot frame |
| Text streaming | send start-partial + deltas; always follow with `message_end` entry as truth; do not assume ≥1 delta |
| Idle/busy | `snapshot.run` presence / `run_start`/`run_end` |
| Steer/follow-up | `submit({whenBusy:"steer"\|"followUp"\|"reject"})`; show `inbox`; steer lands after the current tool round |
| Abort | `conversation.abort()`; completion = `submission(unanswered,"aborted")` |
| Crash recovery | open store → `resume()`; stale `running` tool slots in a pre-resume snapshot are normal; classify tool `replay` |
| Ask | tool with `control.terminate`; pending question derived from last `ask_user` tool-result; answer = ordinary `submit` |
| Wrap-up | engine interface owns its own event/snapshot types: `watchEvents` is experimental |

## Subscription provider spike

Ticket `work-wolfpack-Bdncvl1`. One real durable turn, NO tools, billed to the Claude Max subscription through a thin pi-ai `Provider` over `@anthropic-ai/claude-agent-sdk` (^0.3.310, installed in this spike only). **Result: PASS.**

Run: `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN node src/cli.ts sub` (the CLI also refuses to run if the key is present; `~/.wolfpack/.env` is never read by `sub`). Evidence: `evidence/sub-subscription.json`. Code: `src/sdk-provider.ts`.

### Auth mechanism actually used
- **No env token, no creds file**: `CLAUDE_CODE_OAUTH_TOKEN` unset, `~/.claude/.credentials.json` does not exist. The bundled `claude` CLI that the SDK spawns read the **macOS Keychain item `Claude Code-credentials`** (the `claude /login` OAuth login). Nothing was passed to it.
- Proof of non-API billing: a probe `query()` with the key stripped reports `system/init` `apiKeySource: "none"` (API-key billing would say `ANTHROPIC_API_KEY`/etc.). `total_cost_usd` in the result (~$0.00016) is notional, not a charge.
- **The child env must have `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` stripped** (`childEnv()`): Claude Code prefers the key over OAuth. The provider strips them itself, so even with the key in the parent (VPS wolves) the turn still bills the subscription. On a VPS with no Keychain, expect `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `~/.claude/.credentials.json`; not tested here.
- Gate on pi-ai side: `createProvider({auth})` requires `auth.apiKey` or `auth.oauth`. Mirrored the old bridge's `apiKey: "not-used"`: `auth: { apiKey: { name, resolve: async () => ({ auth: { apiKey: "not-used" }, source: "claude-code-oauth" }) } }`. `resolve()` returning a result = "configured"; no credential store needed, no `login`.

### Provider shape (pi-ai 1.4.0)
- `createProvider({ id: "claude-bridge", auth, models, api: { stream, streamSimple } })`, then `models.setProvider(p)`. `ProviderStreams` needs both `stream` and `streamSimple`; both point at the same function. Model: `claude-haiku-5-5`, `api: "claude-bridge"` (`Api` accepts arbitrary strings), costs zero (subscription).
- Durable agent config is just `model: { provider: "claude-bridge", modelId: "claude-haiku-5-5" }`; durable resolves it through the `Models` passed to `Harness.open`. Nothing in the engine knows about the SDK.
- 1.4 passes providers a **`TranscriptContext`** (`messages` only, branded): the system prompt and tools are **folded into leading `role:"system"` messages** (`content`, `sections`, `toolsAdded`) rather than `context.systemPrompt/tools`. `convert()` joins system `content` + `sections` into the SDK `systemPrompt`; a single user message becomes the prompt verbatim; longer histories are flattened to `[user]/[assistant]/[tool result]` text (fine for no-tools; wrong for tools, see open questions).

### Event mapping (SDK -> pi-ai `AssistantMessageEvent`)
Query options: `tools: []`, `maxTurns: 1`, `persistSession: false`, `settingSources: []`, `strictMcpConfig`, `skills: []`, `includePartialMessages: true`, `systemPrompt: <string>` (custom, not the claude_code preset).
| SDK | pi-ai |
|---|---|
| (before first message) | `start{partial}` |
| `stream_event` `content_block_start` (text) | push `{type:"text",text:""}`, `text_start` |
| `content_block_delta` `text_delta` | append to block, `text_delta{delta}` |
| `content_block_stop` | `text_end{content}` |
| `message_start.usage` / `message_delta.usage` | `usage.input/cacheRead/cacheWrite` / `usage.output` |
| `result` success | `done{reason:"stop", message}` (if no stream events were seen, fall back to `result.result` as one text block) |
| `result` `is_error` or non-success subtype | `error{reason:"error"}` with `errorMessage` |
| abort signal | `query.close()`, `error{reason:"aborted"}` |
- pi-ai needs: `start` first, a mutable shared `partial` (it is the live message, not a snapshot), exactly one terminal `done|error`, then `stream.end()`.
- `AssistantMessage.usage.cost` is zeroed (no pricing for the subscription); usage tokens do flow into the durable `usage_changed` event (`claude-bridge/claude-haiku-5-5: input 2, output 69, cacheWrite 579`). `cacheWrite` is ~600 tokens on a one-line prompt: Claude Code's own fixed preamble is still sent even with a custom systemPrompt and `tools: []`.
- Thinking is not mapped (`reasoning:false`); `thinking_*` events and `thinkingLevel` are ignored.

### Durable behaviour with this provider
- Event timeline is identical to the API-key path: `... message_start(assistant) > message_end(pi.assistant) > turn_end > run_end > submission(done) > usage_changed`. This run produced **zero `message_update` batches** (5 s turn): the stream is throttled to 100 ms partial commits and the SDK emitted text in a few big deltas. `message_start(assistant)` carried a partial ("... eats fish,") and the tail only existed in `message_end` (same lossy-middle finding as §1). Latency ~5.5 s for a one-sentence haiku turn (CLI spawn dominated).
- Entry records `provider:"claude-bridge"`, `api:"claude-bridge"` as the assistant's origin, so a later switch to another provider mid-conversation sees foreign-provider history (pi-ai normally transforms that).

### Surprises (1.4-specific)
- `context.systemPrompt` / `context.tools` no longer exist for providers (transcript form only); the old bridge's `toBridgeContext` exists to undo exactly this.
- `createProvider` demands `auth` even for ambient auth; the escape hatch is a `resolve()` that always succeeds. `Models.getAvailable()` will therefore always list this provider, even on a machine with no login; failures surface only at stream time as an `error` event (`/login` or auth text in the SDK `result`). A real provider should add `auth.apiKey.check` that verifies a login exists (Keychain/creds file/`CLAUDE_CODE_OAUTH_TOKEN`).
- `Harness.open` with only a provider that needs no key works; no `ANTHROPIC_API_KEY` is needed anywhere in the engine for this path.

### Open questions for the tool-streaming gate (ticket 2)
1. **Where do tools execute?** With `tools: []` the SDK never calls anything. pi-durable owns tool execution/replay safety, so tools must be exposed to Claude as an in-process MCP server (as the old bridge does) whose handlers park until durable produces the result, OR the provider must stop the query at `tool_use` and resume. Parking a live subprocess across a durable crash is impossible: how does a rebuilt turn re-attach?
2. **`maxTurns: 1` vs tool turns**: end the query at the first `tool_use`, emit `toolcall_start/delta/end` + `done{reason:"toolUse"}`, and start a **fresh query** next call with history rebuilt (including `tool_use`/`tool_result` pairs) as the prompt. Needs a faithful transcript -> SDK input conversion (structured `AsyncIterable<SDKUserMessage>` or session JSONL, not the text flattening used here). Cost: cache re-writes every tool round, since each call is a new CLI process (~600+ tokens of cacheWrite per call here).
3. **Tool name mapping**: SDK-side names would be `mcp__<server>__<tool>`; map to/from pi tool names. Reject/ignore any CC built-in tool use (must be disabled; verify `tools: []` really blocks them with MCP present).
4. **Streaming tool args**: confirm `input_json_delta` -> `toolcall_delta` and that `toolcall_end.toolCall.arguments` parses; SDK only validates against the MCP schema.
5. **Replay safety/crash**: a SIGKILL mid-query leaves an orphan `claude` child; need process-group kill on durable resume, plus idempotency since the model call will be re-issued (and re-billed against quota).
6. **Subscription limits**: rate-limit/usage-limit errors arrive as `result` text or assistant `error` (`rate_limit`, `authentication_failed`; see `isSdkInfraFailure` in `packages/engine/src/adapters/claude-agent-sdk.ts`); map to retryable pi-ai errors so durable's retry/backoff handles them.
7. **Concurrency**: one CLI process per active turn; check whether parallel conversations on one Max login hit throttling.
8. **Thinking/effort and images**: not mapped here; `thinkingLevel` -> SDK `thinking`/effort options and image blocks need the structured-input path from (2).

## Tool-streaming gate

Ticket `work-wolfpack-BHgQm25`. Gate for feature `work-wolfpack-RhY15Hp`. **VERDICT: PASS** — pi-durable's engine executes the tool mid-turn while the model runs on the Max subscription through the Agent SDK. Code: `src/sdk-provider-tools.ts` (provider), `gate` subcommand in `src/cli.ts`. Run: `env -u ANTHROPIC_API_KEY GATE_MODE=park|replay GATE_VARIANT=add|steer node src/cli.ts gate`. Evidence: `evidence/gate-{park,replay}-{add,steer}.json` (all four PASS).

### Plumbing: where tools reach a provider (pi-ai 1.4)
- Providers get a `TranscriptContext` (`messages` only). `Context.tools`/`systemPrompt` are folded by `normalizeContext()` into a leading `role:"system"` message (`toolsAdded`/`toolsRemoved` deltas, further system messages mid-transcript can change tools).
- The stock provider (`dist/api/anthropic-messages.js:379`) does `getCurrentTools(messages)` from `@earendil-works/pi-ai/utils/transcript` (also `getCurrentSystemMessage`, `resolveTranscriptTools`). **The sdk-provider does the same** — no other channel exists. (The earlier spike's "no tools field" was exactly this.)
- Tool calls out: stock emits `toolcall_start` (block `{type:"toolCall",id,name,arguments,partialJson}`) → `toolcall_delta(partial_json)` → `toolcall_end{toolCall}` (partialJson stripped, args parsed), `message_delta.stop_reason: tool_use` → `done{reason:"toolUse"}`. Results in: next call's transcript ends `[assistant(toolCall blocks), toolResult{toolCallId,toolName,content,isError}…]`. The SDK stream maps 1:1 (`content_block_start tool_use` / `input_json_delta` / `content_block_stop`).

### Strategy used: A (MCP passthrough), two variants — both PASS
Tools are exposed as an in-process MCP server (raw `McpServer` + `ListTools`/`CallTool` handlers, TypeBox schema served verbatim as in the old bridge; SDK `tools: []` so no CC built-ins; `allowedTools: mcp__durable__<name>` so nothing prompts). **The handler never executes anything**: it reads the `tool_use` id from `_meta["claudecode/toolUseId"]` and parks a promise. SDK `mcp__durable__add` is stripped to `add` on the way out. The provider ends the pi stream at `message_stop` with `stop_reason:tool_use` → `done{toolUse}`; durable runs the tool (`tool_execution_start/end` visible to the watcher); the next `streamSimple` call carries the result.
- **park** (the old bridge's mechanism, default): ONE `query()` lives across rounds. Round 2's `streamSimple` detects trailing `toolResult`s whose ids ∈ the live query's `expecting` set, swaps in its new stream, and resolves the parked handlers; the SDK's own next turn streams into the new pi stream. Streaming-input prompt (`AsyncIterable<SDKUserMessage>`) is required so a **steer** can be written to CLI stdin *before* the tool result is released (`priority:"next"`); the input is closed after the final `end_turn` so the CLI exits. `maxTurns` 12.
- **replay**: at `tool_use` the provider `close()`s the query (kills the child). Next call is a **fresh query** whose prompt is the transcript flattened to text, tool pairs rendered as `[called tool add id=… args=…]` / `[result of tool call …]`, `maxTurns:1`. Works (model answers correctly, doesn't re-call the tool) but is lossy (no real tool_use/tool_result blocks). A faithful version needs session-JSONL resume (the old bridge's `session-verify`/sync machinery) — not needed for the gate. This path is also exactly the **crash-recovery path** (see below), so it was exercised.

### Results (haiku-5-5, `ANTHROPIC_API_KEY` stripped, prompt "use the add tool to compute 17+25, then say the sum in words")
Event sequence seen by the durable watcher (park/add): `message_start(user) > message_end(pi.user) > submission(placed) > run_start > turn_start > message_start(system) > message_end(pi.system) > message_start(assistant) > message_end(pi.assistant[toolCall add{a:17,b:25}]) > usage_changed > tool_execution_start(add toolu_…) > tool_execution_end > message_start(toolResult) > message_end(pi.tool-result) > turn_end > turn_start > message_start(assistant) > message_end(pi.assistant "42 — forty-two") > turn_end > run_end > submission(done)`. Tool ran in the engine (`toolLog`: `add {"a":17,"b":25}` once). Final answers: "Forty-two." / "42 — forty-two" — correct.

| | park/add | replay/add | park/steer | replay/steer |
|---|---|---|---|---|
| SDK `query()` / `claude` child processes | **1** / 1 | **2** / 2 | 1 / 1 | 2 / 2 |
| round 1 (spawn → `done toolUse`) | 1.5–2.3 s | 1.7 s | 1.3–1.5 s | 1.7 s |
| round 2 (call → `done stop`) | **~1.1 s** | ~2.3 s | 0.8–1.0 s | 2.0 s |
| round 1 tokens (in/out/cacheRead/cacheWrite) | 2/73/1068/0* | 2/73/1068/0* | 2/55/0–1076/1076 | 2/55/1076/0* |
| round 2 tokens | 2/9/1171/0 | 2/8/**0/1203** | 2/64/1076/198 | 2/10/**0/1241** |
| total turn | ~3.0–3.8 s | 4.2 s | 5.7 s (3 s tool) | 7.3 s |
\*Round-1 cache is warm after the first run in the same minute; a cold start writes ~1070 tokens (CC's fixed preamble + tool schema). Park round 2 reuses the cache (`cacheRead` ≈ 1100, tiny write); **replay re-writes ~1200 tokens of cache on every round** (new process, cold prefix) and costs one extra CLI spawn (~1 s). Subscription so $0, but quota-wise replay ≈ +1.2k cache-write tokens per tool round.
- **Steer after the tool round: PASS** in both (final reply `PINEAPPLE`, timeline `tool_execution_end > pi.tool-result > pi.user(steer) > turn_end > turn_start > assistant`). In park mode it only works because the steer is pushed to stdin before the result; without that (first attempt) the model answered "finished" and ignored the steer.
- No stray processes left by the spike (`pgrep -P` empty after `harness.close`; `shutdown()` kills a parked query). The 3 `claude` processes in `ps` before/after belong to other sessions.

### Gotchas found
1. **durable aborts each call's `AbortSignal` when the call is over** (after `done`). A provider that maps `signal abort → close query` must only act if that call's round is still streaming (`live.cur === round`); otherwise it kills the parked query one tick after the `toolUse` round ends and park silently degrades to rebuild. (First run did exactly that — still produced a correct answer through the rebuild path.)
2. `getCurrentTools()` is the only source of tool defs; tool set can change mid-conversation, but the MCP server is fixed per query → in park mode a tool-set change should force a fresh query (not implemented).
3. Parallel tool calls: one `tool_use` per block, one parked handler each, matched by id; durable returns all results in one transcript tail → `trailing.every(expecting.has)`. Not exercised (single call tests only).
4. `thinking_*`, images, `thinkingLevel`, and cost still unmapped (open questions 8 unchanged).

### Rate-limit / error mapping
durable retries per `ConversationRetryPolicy` using pi-ai `isRetryableAssistantError(message)` — a **regex over `errorMessage`** (`utils/retry.js`): retryable = `overloaded`, `rate.?limit`, `429/500/502/503/504`, `server.?error`, `timeout`, `connection lost`…; **non-retryable** = `billing`, `quota exceeded`, `Monthly usage limit reached`… So the provider must shape the *text*. Implemented `mapSdkError`: SDK `assistant.error` `rate_limit` → `"rate limit (429): …"`, `overloaded` → `"overloaded: …"`, `server_error` → `"server error (500): …"` (all retried with backoff), `billing_error`/`account_on_hold` → `"billing: …"` and Max-plan usage-limit result text (`/usage limit|5-hour|weekly limit/`) → `"quota exceeded: …"` (NOT retried: resets in hours), `authentication_failed` etc. pass through un-retried. A dead CLI → `"claude process ended unexpectedly (connection lost)"` (retryable). The SDK also streams `rate_limit_event` (`rate_limit_info`) — captured to `stats.lastRateLimit` for the console to surface. **Not provoked live** (would burn quota); mapping is from SDK types + retry.js, unverified end-to-end.

### Crash / replay implications (reasoned from the mechanism)
Window = between `done{toolUse}` and the next `streamSimple`.
- **park mode state is process-memory only**: the live `query()` (child process), the parked handler promises, `expecting`. If wolfd dies there, the `claude` child is orphaned (parent gone; with a streaming-input pipe it should see stdin EOF and exit — verify; also add a process-group kill/`pkill` of orphans on startup) and *nothing durable references it*.
- On restart durable's run resumes: the assistant entry (with the toolCall) is persisted; the tool is re-run or not per its `replay` flag (§5: `safe` re-executes, `unsafe` parks); once a `pi.tool-result` exists, durable calls `streamSimple` with transcript `[… assistant(toolCall), toolResult]`. `live` is `undefined` in the new process ⇒ `continuing` is false ⇒ **fresh-rebuild path** (identical to replay mode, which was tested and passed). So crash recovery degrades park → replay: one extra spawn + cache rewrite, lossy history rendering, and **the model is re-billed for the round** — but never wedges, because the provider never assumes the parked query exists (it verifies `expecting ⊇ trailing ids`, else rebuilds).
- If the crash is *before* the tool-call entry is committed, durable just re-issues the model call from the prior transcript — a fresh query; the earlier partial SDK turn is wasted quota, nothing double-executes (the SDK executed nothing; only durable's `replay` classification matters for tools).
- Because the SDK never executes tools, a replayed model call cannot cause side effects — all tool idempotency is durable's existing `replay: safe|unsafe` contract. This is the key property that makes strategy A fit the fork.
- Residual risks: orphan CLI processes after SIGKILL (needs startup sweep); a parked process that outlives a long tool (the CLI's MCP tool-call timeout — not measured; `slow` 3 s was fine, a minutes-long tool may hit it → falls back to a protocol error; rebuild path covers it only if the handler returns/ the call errors cleanly); a lingering parked query per conversation if a run is abandoned (needs idle TTL → `shutdown()`).

### Answers to the 8 open questions (from "Subscription provider spike")
1. Tools execute in durable; SDK handler parks (park) or process is killed (replay). Re-attach after crash = not possible, rebuild instead (§crash).
2. Both end-at-tool_use+rebuild and park work. Rebuild prompt used text flattening; faithful tool_use/tool_result replay needs session-JSONL resume (not built).
3. `mcp__durable__<name>` ↔ `<name>` mapping done; `tools: []` + `strictMcpConfig` blocked all CC built-ins in every run (no built-in tool use observed).
4. `input_json_delta` → `toolcall_delta` and `toolcall_end.toolCall.arguments` parse: PASS (args `{a:17,b:25}` executed by the engine). Streaming deltas are not visible as separate durable events at this scale (throttled partial commits).
5. See crash analysis; process-group kill/orphan sweep still TODO.
6. Mapped (above), not provoked.
7. Concurrency: not tested (one conversation). Park mode holds one child per active turn; ~1 s spawn + ~1 k-token cache write each.
8. Still open (thinking/images).

### VERDICT: PASS
The provider-core mechanism (tool defs from `getCurrentTools` → MCP passthrough → `toolcall_*` events + `done{toolUse}` → engine executes → result via next transcript → SDK continues) is viable. Recommended for the fork: **park as the fast path with replay as the mandatory fallback** (same code, chosen per call by `expecting ⊇ trailing toolResult ids`), plus orphan sweep, idle TTL, session-JSONL-faithful rebuild, and a live rate-limit probe.
