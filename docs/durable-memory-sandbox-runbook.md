# Durable memory: by-hand sandbox runbook

Verified 2026-10-26 on branch `console` (snapshot/install, extension-tools and natural-language bind re-verified live after fixes), macOS, subscription transport (claude-bridge), haiku. All commands below
were run as written. Everything lives in `/tmp/wolfpack-sandbox-test` (outside `~/wolves`); `~/wolves` is only READ.
Never run ssh or `--host` snapshots for this.

## 0. Build, and hash the live dirs (before)

```sh
cd /Users/lukaflores/Code/wolfpack && npm run build
T=/tmp/wolfpack-sandbox-test; P=47391; mkdir -p $T
cat > $T/hashlive.sh <<'X'
#!/bin/bash
for d in "$HOME/wolves/sfo-01/hal/den" "$HOME/wolves/knowledge/base"; do
  n=$(cd "$d" && find . -type f ! -name 'session.sqlite*' | wc -l | tr -d ' ')
  h=$(cd "$d" && find . -type f ! -name 'session.sqlite*' | LC_ALL=C sort | while read -r f; do shasum -a 256 "$f"; done | shasum -a 256 | cut -d' ' -f1)
  echo "$d files=$n sha256=$h"
done
X
chmod +x $T/hashlive.sh; $T/hashlive.sh | tee $T/hash-before.txt
```
Expect two lines: den `files=78`, base `files=685` (the base count drifts when Syncthing syncs; compare before vs after
within one session only).

## 1. Stage `<source>/{work,ops,den}` (read-only copies; no manual stripping)

No mirrored `work-events.jsonl` exists locally, so make a tiny ledger (1 feature + 1 task) with the real work server. It writes the item .md files under `<source>/work/base/domains/*/work`, which
`snapshot --from` reads when `<source>/base` is absent (a `<source>/base` wins if you do have one). No manual copy.

```sh
S=$T/source; mkdir -p $S/{work,ops/inbox/haldev,ops/receipts,ops/parked,den}
rsync -a --exclude='session.sqlite*' ~/wolves/sfo-01/hal/den/ $S/den/
cat > $T/mkledger.mjs <<'X'
import { startLocalWorkServer } from "/Users/lukaflores/Code/wolfpack/packages/agent/dist/index.js";
const srv = await startLocalWorkServer({ ledgerDir: process.argv[2], token: "fixture" });
const post = async (b) => (await (await fetch(`${srv.url}/work`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": "fixture" }, body: JSON.stringify(b) })).json());
const f = await post({ kind: "feature", domain: "wolfpack", title: "sandbox demo feature", assignee: "owner" });
const t = await post({ kind: "task", domain: "wolfpack", title: "sandbox demo task", assignee: "haldev", successCriteria: "ok", partOf: f.id });
console.log(JSON.stringify({ feature: f.id, task: t.id })); await srv.close();
X
node $T/mkledger.mjs $S/work | tee $T/ids.json      # {"feature":"work-wolfpack-…","task":"work-wolfpack-…"}
```

## 2. Snapshot

```sh
node packages/cli/dist/bin/wolfpack.js sandbox snapshot haldev --dev-root $T/dev --from $S    # add --force to redo
```
Expect `ledger events 2, work items 2, ops files 0, den files ~72`, `extensions installed into …/den/extensions: memory` and the `sandbox: root:` hint.
The host's `den/extensions/` is never copied; current bundles are built from this checkout (as `wolfpack sync` builds them) and installed.
Keys come from `--extensions k1,k2`, else the source wolf's `extensions:` (`<from>/wolf.yaml` or `--wolf-yaml <file>`), else `memory`; dropped den extensions are warned about; `--no-install-extensions` skips it. Check the strip:
```sh
python3 -c "import json;print(json.load(open('$T/dev/snapshot.json'))['excluded'])"
ls $T/dev/den/factory $T/dev/den/.memory      # factory: task-cache.json only; .memory: archive only
```
Expect `excluded` = `session.sqlite*, session-backups, backups, factory/conversations, tasks/active.json*, .memory/pool, .memory/watermarks, extensions`.

## 3. Check the installed extension bundle (nothing to build by hand)

The snapshot step already installed a bundle that matches this checkout. To refresh it later without re-snapshotting
(e.g. after editing `extensions/wolfpack-memory`, or after `npm run build`-less changes), run:

```sh
node packages/cli/dist/bin/wolfpack.js sandbox install-extensions $T/dev [--extensions memory,telegram]
grep -c observation_captured $T/dev/den/extensions/wolfpack-memory/index.js     # >=1
grep -c task_bind $T/dev/den/extensions/wolfpack-memory/index.js                # >=1
```

## 4. Wolf config and boot

`extensions: [memory]` is required. Without it wolfd logs `warning: …memory configured but not in extensions: memory is off` at boot and the memory routes answer `409 memory_unavailable` ("memory is off: the memory extension is not loaded"; a loaded-but-gated extension says "memory is inert").
`tiers:` in wolf.yaml picks haiku for everything; models.json is an unedited copy of 1uk4's (subscription transport; no key is read or printed).

```sh
mkdir -p $T/wolf && cp ~/wolves/local/1uk4/models.json $T/wolf/models.json
cat > $T/wolf/wolf.yaml <<X
name: haldev
domains: [personal, snapjack, wolfpack]
extensions: [memory]
workspace: $T/wolf
tiers:
  main: { model: claude-haiku-5-5, thinking: low }
  smart: { model: claude-haiku-5-5 }
  fast: { model: claude-haiku-5-5 }
sandbox:
  root: $T/dev
memory:
  defaultDomain: wolfpack
  consolidation: { threshold: 2000, poolTarget: 1000, trigger: hybrid, interval: 2m }
X
(env -u PI_SUBAGENT_AGENT WOLFPACK_MODELS_FILE=$T/wolf/models.json nohup node packages/harness/dist/bin/wolfd.js --config $T/wolf/wolf.yaml --port $P > $T/wolfd.log 2>&1 &)
sleep 8; grep -v Warn $T/wolfd.log
```
Expect: `[wolfd] sandbox: den=$T/dev/den KB_OPS=$T/dev/ops WORK_ENDPOINT=http://127.0.0.1:<n>`,
`[memory] starting: sandbox (…)`, `Extension wolfpack-memory loaded`, `wolfd: haldev serving http://127.0.0.1:47391`.
(No node_modules symlink needed. `env -u PI_SUBAGENT_AGENT` matters when you launch from inside a pi subagent shell: that variable makes `task_bind` refuse with "Subagents don't bind", and the refusal then sticks in the conversation history; if it happened, delete `$T/dev/den/session.sqlite*` and restart.) Sanity: `curl -s -X POST -H 'X-Protocol-Version: 1' localhost:$P/v1/wolves/haldev/memory/consolidate`
-> 200 `{"observationsProcessed":0,...}`.

## 5. Talk (events stream first)

```sh
(curl -sN -H 'X-Protocol-Version: 1' localhost:$P/v1/wolves/haldev/events > $T/events.sse &)
cat > $T/say.sh <<'X'
#!/bin/bash
# say.sh <port> "<text>": submit on the home thread, wait for turn end, print tool/turn-end frames
curl -s -X POST -H 'X-Protocol-Version: 1' -H 'Content-Type: application/json' \
  -d "$(node -e 'console.log(JSON.stringify({input:process.argv[1],whenBusy:"reject"}))' "$2")" localhost:$1/v1/threads/haldev%2Fhome/submit; echo
curl -sN --max-time 120 -H 'X-Protocol-Version: 1' localhost:$1/v1/threads/haldev%2Fhome/stream | grep -E 'tool|turn-end|error' | cut -c1-200 | head -8
X
chmod +x $T/say.sh
$T/say.sh $P "Hi. We decided to cache session lookups for five minutes because the profile endpoint is the hot path. Reply in one short sentence."
$T/say.sh $P "We also agreed the cache should be invalidated on profile edit. One short sentence back please."
```
Expect `{"messageId":"…","disposition":"started"}` then a `turn-end … "reason":"complete"` frame per message, and in
`$T/events.sse` an `observation_captured` per turn (`"threadId":"haldev/home"`, `"target":{"kind":"den"}`, a domain, a redacted one-line summary).

## 6. Bind (natural language)

Ask in plain language; the model is offered `task_bind` (wolfd now offers every loaded extension's tools) and calls it:

```sh
TASK=$(python3 -c "import json;print(json.load(open('$T/ids.json'))['task'])")
$T/say.sh $P "Please bind to the task $TASK so what we learn is recorded against it. Reply with one short sentence once done."
cat $T/dev/den/factory/conversations/1/active-task.json
$T/say.sh $P "Bound-thread note: we chose Redis for the session cache because it supports per-key expiry. One short sentence back."
```
Expect a `tool-start` frame named `task_bind`, a `tool-end` "Bound to: [<task>] …", and `active-task.json` with `workId`, `domain`,
`featureId`. Binding is re-read every turn, so no restart. Expect the next `observation_captured` to carry
`"target":{"kind":"work","workId":"<task>","featureId":"<feature>"}`.

## 7. Consolidate, Record, promote

```sh
curl -s -X POST -H 'X-Protocol-Version: 1' localhost:$P/v1/wolves/haldev/memory/consolidate; echo
```
Expect 200, e.g. `{"observationsProcessed":8,"topicsCreated":1,...,"recordsWritten":1,"observationsPending":0,"topicIds":["session-lookup-caching"]}`.
```sh
F=$(python3 -c "import json;print(json.load(open('$T/ids.json'))['feature'])")
sed -n '/^## Record/,$p' $T/dev/base/domains/wolfpack/work/$F.md
```
Expect `### Decisions` with `The session cache uses Redis. — why: …per-key expiry…`. The Record lands on the task's **parent feature**
(the task file has none). Then:
```sh
curl -s -i -X POST -H 'X-Protocol-Version: 1' localhost:$P/v1/wolves/haldev/memory/promote | sed -n '1p;$p'; sleep 40
grep -o '"type":"[a-z_]*"' $T/events.sse | uniq -c
ls $T/dev/ops/inbox/haldev; ls $T/dev/den/.memory/sessions/durable; cat $T/dev/den/.memory/watermarks/1.json
```
Expect `HTTP/1.1 202` + `{"jobId":"promote-…","status":"started"}`; events in order: `observation_captured` (x5),
`topic_consolidated`, `promote_started`, `contribution_emitted`, `promote_finished`; an inbox file
`session-lookup-caching-<hash>.md` (frontmatter `from: haldev`, `change: create`); `sessions/durable/{INDEX.md,session-lookup-caching.md}`;
watermark like `{"lastEntryId":27}`.

## 8. Restart: watermark resumes

```sh
pkill -f "curl -sN"; pkill -f "wolfd.js --config"; sleep 3; cp $T/dev/den/.memory/watermarks/1.json $T/wm-before.json
(WOLFPACK_MODELS_FILE=$T/wolf/models.json nohup node packages/harness/dist/bin/wolfd.js --config $T/wolf/wolf.yaml --port $P > $T/wolfd2.log 2>&1 &)
sleep 25; diff $T/wm-before.json $T/dev/den/.memory/watermarks/1.json && echo WATERMARK_SAME; wc -l < $T/dev/den/.memory/pool/observations.jsonl
```
Expect `WATERMARK_SAME` and pool `0` (nothing re-observed; no model calls).

## 9. No sandbox / no `memory.live` -> inert

```sh
pkill -f "wolfd.js --config"; sleep 2; mkdir -p $T/wolf2/den/extensions/wolfpack-memory
cp $T/wolf/models.json $T/wolf2/; cp $T/dev/den/extensions/wolfpack-memory/index.js $T/wolf2/den/extensions/wolfpack-memory/
cat > $T/wolf2/wolf.yaml <<X
name: haldev2
domains: [personal, snapjack, wolfpack]
extensions: [memory]
workspace: $T/wolf2
tiers:
  main: { model: claude-haiku-5-5, thinking: low }
X
(WOLFPACK_MODELS_FILE=$T/wolf2/models.json nohup node packages/harness/dist/bin/wolfd.js --config $T/wolf2/wolf.yaml --port 47392 > $T/wolfd3.log 2>&1 &); sleep 8
grep inert $T/wolfd3.log
for a in consolidate promote; do curl -s -i -X POST -H 'X-Protocol-Version: 1' localhost:47392/v1/wolves/haldev2/memory/$a | sed -n '1p;$p'; echo; done
```
Expect `[memory] inert: durable memory is off: set sandbox: true or memory.live: true…` and both routes `409 {"code":"memory_unavailable",…}`.

## 10. Stop, re-hash, clean up

```sh
pkill -f "wolfd.js --config"; pkill -f "curl -sN"; sleep 2
$T/hashlive.sh > $T/hash-after.txt; diff $T/hash-before.txt $T/hash-after.txt && echo UNCHANGED
rm -rf /tmp/wolfpack-sandbox-test
```

## What to look at (under `$T/dev` unless noted)
- `$T/events.sse` — memory events (metadata only); `$T/wolfd.log` — boot lines, `[memory]` lines.
- `snapshot.json` (`excluded`, `counts`).
- `den/.memory/watermarks/<conversationId>.json`, `den/.memory/pool/observations.jsonl` (empty after consolidate),
  `den/.memory/sessions/durable/*.md` (session topics), `den/memory/` (den topics, after promote), `den/.memory/archive/`.
- `den/factory/conversations/<cid>/active-task.json` (binding).
- `base/domains/wolfpack/work/<feature-id>.md` -> `## Record` (served via the local work server at the `WORK_ENDPOINT` in the log).
- `ops/inbox/haldev/*.md` (contributions); `ledger/work-events.jsonl`.
- `$T/hash-before.txt` vs `hash-after.txt`.

## Known limits
- `/v1` only addresses the home thread (`haldev/home`, conversation 1); binding or talking in other conversations isn't reachable by hand.
- Bundles in the dev den are installed from the checkout at snapshot time; re-run `sandbox install-extensions` after changing an extension.
- `extensions: [memory]` must be in wolf.yaml; `memory.defaultDomain` only applies to untagged observations (the classifier picked `snapjack` for the cache talk).
- `KB_BASE` stays pointed at the live `~/wolves/knowledge/base` (read-only context), so the Syncthing churn there is expected.
- The ledger (`work-events.jsonl`) did not grow after consolidate; Record writes went to the item `.md` via the work server.
