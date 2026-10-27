# wolfpack-subagents

Interactive **async** subagents for wolfpack. `subagent()` returns immediately;
the sub-agent runs in its own **visible multiplexer pane**, a live widget tracks
every running sub-agent, and each result is steered back into the main session
as a new turn when it finishes.

Ported from [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents)
and adapted to earendil pi 1.0.x, with a pluggable **MuxBackend** so the pane
multiplexer is chosen per wolf.

## Per-wolf multiplexer (Herdr or tmux)

The pane backend is selected by `WOLFPACK_SUBAGENT_MUX`:

| Value   | Behavior |
| ------- | -------- |
| `auto`  | **default** — Herdr if `HERDR_ENV=1`, else tmux if `$TMUX`, else headless |
| `herdr` | force Herdr (`herdr pane split/run/read/close`) |
| `tmux`  | force tmux (`split-window` / `send-keys` / `capture-pane`) |
| `none`  | headless — panes disabled; pane agents fall back to background (with a notice) |

`auto` already does the right thing (macOS wolf under Herdr → herdr; Linux wolf
under tmux → tmux). To pin it, add to the wolf's `.env` (merged by `wolf launch`):

```bash
# <wolfDir>/.env
WOLFPACK_SUBAGENT_MUX=herdr   # mac wolf
WOLFPACK_SUBAGENT_MUX=tmux    # linux wolf
```

Adding a backend is one file in `mux/` implementing the `MuxBackend` interface
(`createSurface`, `sendCommand`, `readScreen`, `closeSurface`, …); the ~5k-line
engine only ever talks to `mux/index.ts`.

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Delegate to a sub-agent, in a pane or in the background (async; result steered back) |
| `subagent_message` | Message a sub-agent by name — steers a running pane agent, resumes a finished one; refused for a running background agent |
| `subagents_list` | The roster: each agent's tier, pane/background and role |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator and wait for a reply |

```json
{ "agent": "scout", "task": "Analyze the auth module" }
```

Fan out by emitting several `subagent` calls in one turn. Completion detection
is file-based (`.exit` sidecar + activity file) with a terminal sentinel
fallback, so it is backend-independent.

## Pane vs background

Each agent has a `pane: true|false` frontmatter key (default `false`); the
`subagent` tool's `pane` param overrides it per spawn, and the user's
`/subagent <agent> <task>` command always opens a pane.

- **pane** — a multiplexer pane the user can watch; `subagent_message` steers it live.
- **background** — the *same* generated launch script
  (`artifacts/<id>/subagent-scripts/*.sh`, same env forwarding and sandbox) runs as a
  detached child (`mux/background.ts`, a `bg:<n>` surface routed by `mux/index.ts`)
  with stdout/stderr in a sibling `.log`. With no TTY pi runs in print mode: one
  autonomous run, then exit. Completion detection (`__SUBAGENT_DONE_n__` in the log,
  `.exit` sidecar), result extraction, widget rows, status and steer delivery are
  shared with panes. The process group is killed on cancel / session shutdown.
- Steering a running background agent is refused with an explanatory message;
  message it after it finishes to resume it (in the background, unless it was a pane
  agent — recorded in the `.loadout.json`). An `ask_question` from a background
  agent ends its run; the reply resumes it.
- No multiplexer available: pane agents run in the background with a notice.

## Orchestrator rules

In pi CLI sessions the main agent gets an `orchestrator_rules` system-prompt section
(delegate recon/diagnosis/research/planning/implementation/review/visualization,
keep decisions and work-item state in the main agent, brief template, when to use
`model` / `pane`). It is skipped inside subagents (`PI_SUBAGENT_AGENT` set).

## Agents

Discovered from (priority: project > global > package):

- **project** — `<cwd>/.pi/agents/*.md`
- **global** — `$PI_CODING_AGENT_DIR/agents/*.md` (wolf-specific agents only)
- **package** — the shared roster in `packages/agents/agents/` (`worker`, `scout`, `planner`,
  `reviewer`; also used by wolfd), plus the `pi.agents` dirs of every local package in the wolf's
  `settings.json` (e.g. `wolfpack-visual-tools` → `visualizer`).
  Repo agents load from the repo; don't copy them into the wolf's agent dir, or
  the copy shadows (and drifts from) the repo file.

Autonomous agents should set `auto-exit: true` so they exit when done and their
result steers back; `system-prompt: append` passes the body as the child's
appended system prompt. Key frontmatter: `name`, `description`, `model`,
`tools` (strict allowlist), `auto-exit`, `system-prompt`,
`subagent_agents` (grant + restrict nested spawning), `cwd`, `session-mode`,
`pane` (run in a pane vs background).

### Models are tiers

`model:` (and the `subagent` tool's `model` param, which overrides it) must be a
tier: `main`, `smart` or `fast`; no `model:` means `smart`. Anything else fails
the spawn. The tier resolves at spawn through the wolf's model table
(`WOLFPACK_MODELS_FILE`, written by `wolfpack launch`; else the pack config) to
`<provider>/<id>`, with the tier's thinking level, if any, as the `:thinking`
suffix. Agent files can't set thinking. When a sandboxed spawn passes
`--no-extensions`, the extension that registers the resolved model's provider
(e.g. `pi-claude-bridge`) is re-enabled.

## Tier commands

`/main`, `/smart` and `/fast` switch this session's main model (and thinking, if
the tier sets one) to that tier's resolved model, for the session only, like
`/model`.

## Custom tools in subagents (bridge)

Children launch default-deny: `--no-extensions` + `--tools <allowlist>` +
one `-e <ext>` per tool. Built-ins (`read`, `write`, `edit`, `bash`, `grep`,
`find`, `ls`) need nothing. Any other tool must be mapped to its backing
extension file. Other extensions register theirs at `session_start` via the
bridge this extension exposes:

```ts
(globalThis as any).__pi_interactive_subagents?.registerToolExtension(
  "write_mermaid",
  "/abs/path/to/tools/mermaid_tools.ts",
);
```

`wolfpack-visual-tools` uses exactly this to make `write/edit/render_mermaid`
and `write/edit/render_svg` available to the `visualizer`
sub-agent.

## Layout

```
wolfpack-subagents/
├── index.ts            # engine (tool registration, launch, widget, steer-back)
├── session.ts          # session seeding, loadout snapshots, stats
├── status.ts           # live status classification + config.json
├── activity.ts         # child activity recorder + reader
├── subagent-done.ts    # child-side: auto-exit + ask_question
├── mux/
│   ├── index.ts        # backend selection + the surface API the engine imports
│   ├── shared.ts       # MuxBackend contract, shellEscape, pollForExit
│   ├── background.ts   # no-pane backend: detached child + log file
│   ├── tmux.ts         # tmux backend
│   └── herdr.ts        # Herdr backend (herdr pane verbs)
├── tools/safe-bash.ts  # safe_bash + guarded_bash (read-only guard, tools/command-guard.ts)
├── prompts/            # workflow presets
└── config.json.example # status widget config
```
