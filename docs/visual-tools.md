# Visual tools & subagents

Wolves can explain things with rendered diagrams. The pieces:

- **wolfpack-subagents** — async subagents that run in a visible multiplexer
  pane (Herdr on macOS, tmux on Linux) and steer their result back into the
  session. Backend is per-wolf via `WOLFPACK_SUBAGENT_MUX` (`auto` default).
- **wolfpack-visual-tools** — Mermaid/SVG render tools used by the
  `mermaid-maker` / `svg-maker` subagents. They publish a PNG and return its
  path; the orchestrator `read`s it to show it inline.

## Enabling inline images (Herdr + kitty)

pi renders images in the TUI when the terminal supports a graphics protocol.
**Through a multiplexer, pi's `auto` detection fails** — Herdr/tmux report
`TERM=xterm-256color`, so pi disables images and diagrams never appear. Two
things are required:

1. **pi: force the protocol.** In the wolf's `agent/settings.json`:

   ```json
   { "terminal": { "showImages": true, "images": "kitty" } }
   ```

   The CLI adds this automatically for wolves whose `.env` sets
   `WOLFPACK_SUBAGENT_MUX=herdr` (it never overrides an explicit user value).
   Only use `"kitty"` when the outer terminal speaks the kitty graphics
   protocol (kitty, Ghostty, WezTerm). Env equivalent: `PI_IMAGE_PROTOCOL=kitty`.

2. **Herdr: enable graphics passthrough.** It is **off by default**. In
   `~/.config/herdr/config.toml`:

   ```toml
   [experimental]
   kitty_graphics = true
   ```

   Then `herdr server reload-config` **and re-attach the client** (detach +
   `herdr`, or reopen the window) — the renderer activates per attached client.
   Newer Herdr builds use `terminal.kitty_graphics` instead; 0.8.x uses the
   `[experimental]` key above.

Verify end to end: ask a wolf to visualize something; the `mermaid-maker` pane
spawns, renders, and the diagram appears inline. If it shows a blank **gap**,
the client hasn't re-attached since enabling `kitty_graphics`.

Fallback when graphics aren't available: `open <path>` (macOS Preview).

## Where PNGs are stored

Most diagrams explain a point once, so renders are **ephemeral by default**:

- **Ephemeral** — `$TMPDIR/wolfpack-viz/`; auto-cleaned, never committed/synced.
- **Persistent** — opt in with `persist: true` (or ask the maker to "save/keep"
  it): written to `WOLFPACK_VIZ_DIR`, else `$WOLF_DEN/viz`, else `<cwd>/viz`.
