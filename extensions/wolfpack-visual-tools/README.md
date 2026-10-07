# wolfpack-visual-tools

Mermaid + SVG authoring tools for the visualization subagents. Ported from
[amosblomqvist/learn](https://github.com/amosblomqvist/learn/tree/main/extensions/visual-tools)
and wired into **wolfpack-subagents** via its tool-extension bridge.

Replaces the old `wolfpack-show-me` skill.

## What it provides

Six tools, each a thin render-and-inspect authoring loop over ONE managed
source file:

- `write_mermaid` / `edit_mermaid` / `render_mermaid` — write Mermaid source,
  exact-match edit it, render to PNG (via the bundled `@mermaid-js/mermaid-cli`
  + an installed Chrome), returned inline; `save_as` publishes it.
- `write_svg` / `edit_svg` / `render_svg` — same shape for hand-written SVG,
  rendered via `rsvg-convert` (fallback: ImageMagick `magick`).

Plus two subagents (`agents/`):

- **mermaid-maker** — structural/relational visuals (graphs, flows, sequences,
  state machines, trees, ER, timelines).
- **svg-maker** — spatial/geometric visuals (coordinate geometry, number lines,
  vectors, plots, custom shapes).

## How it works with wolfpack-subagents

`wolfpack-subagents` launches each maker in its own pane as a **default-deny**
child (`pi --no-extensions --tools <allowlist> -e <toolfile>`). So the tool
files are **not** loaded as ordinary always-on extensions — instead this
package's `index.ts` registers them on `session_start` through the bridge the
subagents engine exposes:

```ts
(globalThis as any).__pi_interactive_subagents?.registerToolExtension(
  "write_mermaid", "<dir>/tools/mermaid_tools.ts",
);
```

That teaches the engine the `name → tool-file` mapping, so when a maker lists
`write_mermaid` / `render_svg` / … in its `tools:` frontmatter, the engine adds
the right `-e <toolfile>` to the child. The main session only loads the thin
bridge, not the six tools. Delegate via:

```
subagent(agent: "mermaid-maker", task: "<brief>")
subagent(agent: "svg-maker",     task: "<brief>")
```

## Where PNGs go (ephemeral by default)

Most visuals explain a point once and are never reused, so renders are
**ephemeral by default**:

- **Ephemeral** (default) — published to a temp dir (`$TMPDIR/wolfpack-viz/`),
  auto-cleaned, never committed or synced. Right for throwaway explainers.
- **Persistent** (opt-in) — pass `persist: true` to `render_*` (or ask the
  maker to "save/keep" it) to write it under the wolf directory:
  `WOLFPACK_VIZ_DIR` if set, else `$WOLF_DEN/viz`, else `<cwd>/viz`.

Preview renders (no `save_as`) always stay in the per-session staging dir.

## Runtime requirements

- **Mermaid:** Google Chrome (or Chromium) installed, and this package's
  dependencies installed so `node_modules/.bin/mmdc` exists
  (`npm install` in this dir; the CLI bundler inlines deps on deploy).
  `mmdc` is run via the current `node` (`process.execPath`), so a stray old
  `node` on PATH can't break its ESM shebang.
- **SVG:** `rsvg-convert` (librsvg) on PATH, or ImageMagick `magick` as a
  fallback. Looks under `/opt/local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`
  (appended to PATH, never prepended).

Renders fail gracefully with error text when a binary is missing.

## Inline display in the TUI

The maker returns a path; the orchestrator `read`s it and pi renders it inline
when the terminal supports a graphics protocol. Through a multiplexer pi's
auto-detection fails, so force it: `terminal.images: "kitty"` in pi settings.
Under **Herdr** also enable `experimental.kitty_graphics = true` in
`~/.config/herdr/config.toml` and re-attach the client. Otherwise fall back to
`open <path>` (Preview). See `docs/` in the repo root.

## Agent discovery note

`wolfpack-subagents` discovers agents from the package's bundled `agents/`, the
wolf's agent dir (`$PI_CODING_AGENT_DIR/agents`), and the nearest `.pi/agents`.
The canonical source for the maker agents lives here under `agents/`.
