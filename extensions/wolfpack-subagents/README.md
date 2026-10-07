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
| `none`  | headless — panes disabled; `subagent` reports the mux is unavailable |

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
| `subagent` | Spawn a sub-agent in a dedicated pane (async; result steered back) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished |
| `subagents_list` | List available agent definitions |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator and wait for a reply |

```json
{ "agent": "scout", "task": "Analyze the auth module" }
```

Fan out by emitting several `subagent` calls in one turn. Completion detection
is file-based (`.exit` sidecar + activity file) with a terminal sentinel
fallback, so it is backend-independent.

## Agents

Discovered from (priority: project > global > package):

- **project** — `<cwd>/.pi/agents/*.md`
- **global** — `$PI_CODING_AGENT_DIR/agents/*.md` (e.g. the visual makers)
- **package** — this extension's bundled `agents/` (`worker`, `scout`, `planner`, `reviewer`)

Autonomous agents should set `auto-exit: true` so they exit when done and their
result steers back; `system-prompt: append` passes the body as the child's
appended system prompt. Key frontmatter: `name`, `description`, `model`,
`tools` (strict allowlist), `thinking`, `auto-exit`, `system-prompt`,
`subagent_agents` (grant + restrict nested spawning), `cwd`, `session-mode`.

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
and `write/edit/render_svg` available to the `mermaid-maker` / `svg-maker`
sub-agents.

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
│   ├── tmux.ts         # tmux backend
│   └── herdr.ts        # Herdr backend (herdr pane verbs)
├── tools/safe-bash.ts  # bash with dangerous-command blocking (loaded on demand)
├── agents/             # bundled agent definitions
├── prompts/            # workflow presets
└── config.json.example # status widget config
```
