# learnharness provenance

> Snapshot against upstream `6cba9c8` taken on 2026-11-05; totals refreshed after work-wolfpack-63WjMQd (see Removed in work-wolfpack-63WjMQd).

Inventory of what `apps/console` and `apps/desktop` took from **learnharness** (https://github.com/amosblomqvist/learnharness, Copyright (c) Amos Blomqvist, AGPL-3.0-only; all 712 upstream commits are by him).

- Copied into wolfpack in commit `060c20cf` (2026-10-24) from upstream commit `6cba9c8c5afe8a63f47ea4ebae6e91d8a205cebb` (v0.3.4).
- Path mapping: upstream root → `apps/console`; upstream `electron/`, `build/`, `electron-builder.yml` and the packaging scripts (`after-pack.cjs`, `build-server.mjs`, `make-icons.mjs`, `smoke-demo-runtime.mjs`, `smoke-server.mjs`) → `apps/desktop`.
- **Licensing:** there is no relicensing grant. The derived code remains AGPL-3.0-only, and wolfpack is licensed AGPL-3.0-only accordingly (see `LICENSE`, `NOTICE`). The old `ATTRIBUTION.md` claim that the code had been relicensed was wrong and has been removed.
- Method: every tracked file under `apps/console` and `apps/desktop` was compared by git blob hash with the mapped upstream blob at 6cba9c8; modified files were diffed with `git diff --numstat`. "% upstream-derived" = (current lines − lines added vs upstream) / current lines, i.e. the share of today's lines that is still upstream text. Binary files are counted in file totals but not in line percentages. Snapshot of the tree at the time of writing (after the copy commit, so later wolfpack edits are included).

## Totals

| Class | Files |
|---|---|
| (a) copied, unchanged | 109 |
| (b) copied, modified | 109 |
| (c) new in wolfpack | 245 |
| Upstream files removed (not present now) | 264 |
| Tracked files now | 617 |
| Upstream files mapped | 218 |

Note: the copy commit also brought compiled artifacts (`*.js`, `*.d.ts`, `*.map`) that were never upstream; they are no longer tracked and are not counted. Lockfiles (`package-lock.json`) are not carried (removed). Upstream `LICENSE` was not carried either (restored at repo root as `LICENSE`).

## Summary by component

| Component | Files (unchanged / modified / new) | Lines now | % upstream-derived |
|---|---|---|---|
| Tests | 161 (31 / 38 / 92) | 33392 | 46% |
| Console UI & core logic (chat shell, sidebar, composer, keyboard, work views) | 127 (17 / 29 / 81) | 26099 | 46% |
| Knowledge / task graph views | 24 (2 / 2 / 20) | 6675 | 26% |
| App setup, config & storage | 28 (15 / 12 / 1) | 5629 | 97% |
| Server & API routes | 53 (5 / 7 / 41) | 3081 | 45% |
| Chat rendering (markdown, tool rows, streaming) | 17 (8 / 5 / 4) | 2920 | 76% |
| Agent / provider layer (src/agent) | 3 (0 / 3 / 0) | 224 | 81% |
| Electron shell & build/packaging | 11 (2 / 5 / 4) | 1427 | 78% |
| UI kit, fonts & theme | 15 (14 / 0 / 1) | 1320 | 91% |
| Build config & misc (tsconfig, next, eslint, scripts) | 9 (4 / 4 / 1) | 515 | 95% |
| CI / release workflow | 0 (0 / 0 / 0) | 0 | 0% |
| Docs & skills | 4 (0 / 4 / 0) | 254 | 90% |
| Desktop packaging assets (icons, dmg background, entitlements) | 11 (11 / 0 / 0) | 105 | 100% |
| **All** | 617 | 81641 | 51% |

## Components

### Tests

- Status mix: 31 unchanged, 38 modified, 92 new; 0 binary. Still upstream-derived: 46%.
- Rework to replace: Rewrite alongside the code they cover; delete upstream tests as the code is replaced.

### Console UI & core logic (chat shell, sidebar, composer, keyboard, work views)

- Status mix: 17 unchanged, 29 modified, 81 new; 0 binary. Still upstream-derived: 46%.
- Rework to replace: Rewrite the remaining upstream shell components (sidebar, composer, session, keyboard, top-bar) one by one.

### Knowledge / task graph views

- Status mix: 2 unchanged, 2 modified, 20 new; 0 binary. Still upstream-derived: 26%.
- Rework to replace: Graph canvas/layout is largely wolfpack-written on top of an upstream graph-canvas; rewrite the remainder.

### App setup, config & storage

- Status mix: 15 unchanged, 12 modified, 1 new; 0 binary. Still upstream-derived: 97%.
- Rework to replace: Replace config.ts/auth.json/data-dir handling with wolfpack settings and the hub store.

### Server & API routes

- Status mix: 5 unchanged, 7 modified, 41 new; 0 binary. Still upstream-derived: 45%.
- Rework to replace: Re-implement the routes against the wolfpack hub API (many already new); drop the rest.

### Chat rendering (markdown, tool rows, streaming)

- Status mix: 8 unchanged, 5 modified, 4 new; 0 binary. Still upstream-derived: 76%.
- Rework to replace: Re-implement markdown/tool-row/streaming rendering; the ai-elements wrappers are the main upstream-derived pieces.

### Agent / provider layer (src/agent)

- Status mix: 0 unchanged, 3 modified, 0 new; 0 binary. Still upstream-derived: 81%.
- Rework to replace: Replace with the wolfpack agent runtime (packages/agent); most upstream tools/prompts can simply be deleted.

### Electron shell & build/packaging

- Status mix: 2 unchanged, 5 modified, 4 new; 0 binary. Still upstream-derived: 78%.
- Rework to replace: Rewrite main.cjs/remote.cjs/preload around the remote-hub model; rebuild electron-builder config, notarization and update feed.

### UI kit, fonts & theme

- Status mix: 14 unchanged, 0 modified, 1 new; 1 binary. Still upstream-derived: 91%.
- Rework to replace: Swap shadcn-style primitives for our own kit or regenerate from shadcn (MIT) directly; replace cmunbx.ttf if not needed.

### Build config & misc (tsconfig, next, eslint, scripts)

- Status mix: 4 unchanged, 4 modified, 1 new; 0 binary. Still upstream-derived: 95%.
- Rework to replace: Small generic configs; regenerate from tooling defaults.

### CI / release workflow

- Status mix: 0 unchanged, 0 modified, 0 new; 0 binary. Still upstream-derived: 0%.
- Rework to replace: Write wolfpack CI/release workflows from scratch.

### Docs & skills

- Status mix: 0 unchanged, 4 modified, 0 new; 0 binary. Still upstream-derived: 90%.
- Rework to replace: Rewrite docs; drop upstream skills/docs.

### Desktop packaging assets (icons, dmg background, entitlements)

- Status mix: 11 unchanged, 0 modified, 0 new; 5 binary. Still upstream-derived: 100%.
- Rework to replace: Replace icons and dmg background with Wolfpack artwork (the lh_*.svg files are byte-identical upstream assets); entitlements plist is generic but still upstream-copied.

## Third-party and asset notes

- `apps/console/public/fonts/cmunbx.ttf` and `OFL.txt`: Computer Modern Bold (SIL Open Font License 1.1), third-party, unchanged from upstream. Keep `OFL.txt` alongside it.
- `apps/desktop/build/icon.icon/Assets/lh_*.svg` (three files): byte-identical to upstream (learnharness artwork). The lh-debrand branch renames them to `wolfpack_*.svg`; the artwork is unchanged and still upstream-derived. Also byte-identical: `icon-flat.svg`, `icon.icns`, `icon.ico`, `icon.png`, `background*.png`, `icon.icon/icon.json`, `entitlements.mac.plist` (all 11 `apps/desktop/build` files are unchanged). `components/lh-mark.tsx` (logo component) is unchanged too; lh-debrand renames it to `wolfpack-mark.tsx` with the same content. The names are debranded, but the artwork is still upstream and should be replaced.

## Other third-party origins (outside apps/console and apps/desktop)

Not part of the learnharness copy. Upstream licences checked on 2026-11-05 (`gh api repos/amosblomqvist/<repo>/license` and repository contents):

| Package | Upstream | Upstream licence | Status |
|---|---|---|---|
| `extensions/wolfpack-telegram` | badlogic/pi-telegram | MIT | Keeps `"license": "MIT"`; credited in NOTICE |
| `extensions/wolfpack-subagents` | amosblomqvist/pi-interactive-subagents (original HazAT/pi-interactive-subagents) | MIT (Copyright (c) 2026 HazAT) | MIT notice reproduced in NOTICE; package stays AGPL-3.0-only |
| `extensions/wolfpack-visual-tools` | amosblomqvist/learn | **none** (no LICENSE file) | Needs the author's permission or a rewrite |
| `extensions/wolfpack-memory` | none found | n/a | Written in this repo (first commit "replace packages/pi-extension with extensions/wolfpack-memory", no upstream references) |

## Known leftovers

The lh-debrand branch fixes the `homepage` fields, the electron-builder `publish.owner` and the desktop-platform test. After it merges, the remaining upstream references are:

- `apps/console/docs/desktop-release.md` (one mention, if not reworded).
- Credits in the extension READMEs and source comments listed above (kept on purpose).

## Removed in work-wolfpack-63WjMQd

The unused local chat, its routes and the dead components, tools and tests were deleted (93 files, 14065 lines; 46 unchanged-copied, 40 modified-copied, 2 wolfpack-new). Ten npm packages nothing imported were dropped from apps/console/package.json. The attribution in NOTICE and this file is unchanged. The upstream clone was not reachable when this refresh ran, so class counts, line totals and percentages are the previous snapshot minus the removed files (and minus lines removed from edited files): deleted class (a) lines count as fully upstream, class (b) as upstream lines minus lines deleted vs upstream, class (c) as none. Re-run the blob-hash comparison against 6cba9c8 for exact figures.

Totals: tracked files 617; lines now 81641; upstream-derived 51%.

<details><summary>Removed files (class, lines when deleted)</summary>

- `apps/console/.github/workflows/ci.yml` (a, 67)
- `apps/console/.github/workflows/release.yml` (a, 256)
- `apps/console/app/api/activity/route.ts` (a, 14)
- `apps/console/app/api/chats/[id]/dismiss/route.ts` (a, 65)
- `apps/console/app/api/chats/[id]/markdown/route.ts` (a, 37)
- `apps/console/app/api/chats/[id]/settings/route.ts` (a, 48)
- `apps/console/app/api/chats/[id]/steer/route.ts` (a, 32)
- `apps/console/app/api/chats/[id]/stream/route.ts` (a, 23)
- `apps/console/app/api/jobs/route.ts` (a, 23)
- `apps/console/app/api/models/route.ts` (a, 11)
- `apps/console/components/artifacts/live-tool-card.tsx` (a, 65)
- `apps/console/components/compaction-divider.tsx` (a, 48)
- `apps/console/components/enter-submits.ts` (a, 78)
- `apps/console/components/field-cycle.ts` (a, 36)
- `apps/console/components/jobs-context.ts` (a, 18)
- `apps/console/components/latex-glyph.tsx` (a, 53)
- `apps/console/components/queued-steers.tsx` (a, 36)
- `apps/console/components/setup-cta.tsx` (a, 101)
- `apps/console/components/stats-bar.tsx` (a, 195)
- `apps/console/components/thinking-default.ts` (a, 54)
- `apps/console/components/ui/textarea.tsx` (a, 18)
- `apps/console/src/agent/provider-events.ts` (a, 119)
- `apps/console/src/agent/subagents/aborts.ts` (a, 62)
- `apps/console/src/agent/tools/find.ts` (a, 87)
- `apps/console/src/agent/tools/fs-shared.ts` (a, 201)
- `apps/console/src/agent/tools/grep.ts` (a, 178)
- `apps/console/src/agent/tools/heal.ts` (a, 48)
- `apps/console/src/agent/tools/ls.ts` (a, 77)
- `apps/console/src/agent/tools/read.ts` (a, 120)
- `apps/console/src/server/dismissal-park.ts` (a, 80)
- `apps/console/src/server/pi/call-ids.ts` (a, 212)
- `apps/console/src/server/pi/ui-stream.ts` (a, 337)
- `apps/console/src/server/turn-liveness.ts` (a, 74)
- `apps/console/src/server/turn-runs.ts` (a, 81)
- `apps/console/tests/call-ids.test.ts` (a, 142)
- `apps/console/tests/chat-birth-stamp.test.ts` (a, 108)
- `apps/console/tests/enter-submits.test.ts` (a, 82)
- `apps/console/tests/fs-tools.test.ts` (a, 252)
- `apps/console/tests/provider-events.test.ts` (a, 117)
- `apps/console/tests/read-tool.test.ts` (a, 125)
- `apps/console/tests/render-compaction-divider.test.tsx` (a, 80)
- `apps/console/tests/render-queued-steers.test.tsx` (a, 51)
- `apps/console/tests/render-stats-bar.test.tsx` (a, 140)
- `apps/console/tests/setup-dialog-interaction.test.tsx` (a, 185)
- `apps/console/tests/thinking-default.test.ts` (a, 59)
- `apps/console/tests/turn-liveness.test.ts` (a, 60)
- `apps/console/app/api/activity/abort/route.ts` (b, 44)
- `apps/console/app/api/chats/[id]/route.ts` (b, 59)
- `apps/console/app/api/chats/route.ts` (b, 39)
- `apps/console/components/abort-turn-dialog.tsx` (b, 139)
- `apps/console/components/activity-dock.tsx` (b, 450)
- `apps/console/components/artifacts/dispatch-card.tsx` (b, 116)
- `apps/console/components/artifacts/job-card.tsx` (b, 45)
- `apps/console/components/artifacts/steer-card.tsx` (b, 73)
- `apps/console/components/composer-actions.tsx` (b, 17)
- `apps/console/components/delete-session-dialog.tsx` (b, 185)
- `apps/console/components/model-picker.tsx` (b, 426)
- `apps/console/components/new-session.tsx` (b, 287)
- `apps/console/components/plan-block.tsx` (b, 651)
- `apps/console/components/setup-dialog.tsx` (b, 588)
- `apps/console/src/agent/subagents/pi-run.ts` (b, 145)
- `apps/console/src/agent/tool-execute.ts` (b, 232)
- `apps/console/src/core/session-markdown.ts` (b, 121)
- `apps/console/src/server/chat-handler.ts` (b, 352)
- `apps/console/src/server/chats.ts` (b, 55)
- `apps/console/src/server/jobs.ts` (b, 692)
- `apps/console/src/server/observability.ts` (b, 57)
- `apps/console/src/server/turn-service.ts` (b, 70)
- `apps/console/tests/activity-feed.test.ts` (b, 99)
- `apps/console/tests/api-key-hook.test.ts` (b, 46)
- `apps/console/tests/chat-flow.test.ts` (b, 1629)
- `apps/console/tests/composer-actions.test.tsx` (b, 43)
- `apps/console/tests/dismissal-park.test.ts` (b, 174)
- `apps/console/tests/jobs.test.ts` (b, 1091)
- `apps/console/tests/markdown-export.test.ts` (b, 81)
- `apps/console/tests/provider-neutral-agents.test.ts` (b, 225)
- `apps/console/tests/render-abort-turn-dialog.test.tsx` (b, 47)
- `apps/console/tests/render-activity-dock.test.tsx` (b, 221)
- `apps/console/tests/render-live-tool-card.test.tsx` (b, 40)
- `apps/console/tests/render-new-session.test.tsx` (b, 123)
- `apps/console/tests/render-plan-block.test.tsx` (b, 144)
- `apps/console/tests/repair-math-display.test.tsx` (b, 87)
- `apps/console/tests/session-identity.test.ts` (b, 188)
- `apps/console/tests/session-markdown.test.ts` (b, 115)
- `apps/console/tests/tool-abort.test.ts` (b, 156)
- `apps/console/tests/tool-heal.test.ts` (b, 182)
- `apps/console/src/agent/assistant-agent.ts` (c, 91)
- `apps/console/tests/helpers/question-tools.ts` (c, 85)

</details>

## Files per class

<details><summary>(a) Copied, unchanged</summary>

- `apps/console/app/api/chat/route.ts` (since removed: threads use the wolf thread transport, `/api/wolves/<wolf>/threads/<slug>/...`; the console has no `POST /api/chat` or compaction of its own)
- `apps/console/app/api/events/route.ts`
- `apps/console/app/api/graph/render-settings/route.ts`
- `apps/console/app/api/settings/[section]/route.ts`
- `apps/console/app/api/settings/prompts/[...segment]/route.ts`
- `apps/console/app/api/settings/route.ts`
- `apps/console/app/api/stt/token/route.ts`
- `apps/console/app/globals.css`
- `apps/console/app/settings/page.tsx`
- `apps/console/components.json`
- `apps/console/components/ai-elements/conversation.tsx`
- `apps/console/components/ai-elements/shimmer.tsx`
- `apps/console/components/artifacts/tool-call-card.tsx`
- `apps/console/components/backdrop-dismiss.ts`
- `apps/console/components/cluster-geometry.ts`
- `apps/console/components/confidence-rail.tsx`
- `apps/console/components/dock-state-key.ts`
- `apps/console/components/focus-hygiene.ts`
- `apps/console/components/keyboard-shortcuts.tsx`
- `apps/console/components/lh-mark.tsx`
- `apps/console/components/menu-shell.tsx`
- `apps/console/components/mermaid-error.tsx`
- `apps/console/components/mermaid-render.ts`
- `apps/console/components/pan-zoom.ts`
- `apps/console/components/popover-dismiss.ts`
- `apps/console/components/session-find-dom.ts`
- `apps/console/components/session-find.tsx`
- `apps/console/components/session-navigation.tsx`
- `apps/console/components/settings-signal.ts`
- `apps/console/components/settings/appearance.tsx`
- `apps/console/components/settings/controls.tsx`
- `apps/console/components/settings/keyboard-section.tsx`
- `apps/console/components/settings/keys-section.tsx`
- `apps/console/components/settings/model-menu.tsx`
- `apps/console/components/thinking-block.tsx`
- `apps/console/components/top-bar.tsx`
- `apps/console/components/ui/button-group.tsx`
- `apps/console/components/ui/button.tsx`
- `apps/console/components/ui/collapsible.tsx`
- `apps/console/components/ui/glyph-mark.tsx`
- `apps/console/components/ui/hint.tsx`
- `apps/console/components/ui/input.tsx`
- `apps/console/components/ui/separator.tsx`
- `apps/console/components/ui/tooltip.tsx`
- `apps/console/components/update-banner.tsx`
- `apps/console/components/usage-format.ts`
- `apps/console/eslint.config.mjs`
- `apps/console/lib/utils.ts`
- `apps/console/postcss.config.mjs`
- `apps/console/public/fonts/OFL.txt`
- `apps/console/public/fonts/cmunbx.ttf`
- `apps/console/public/worklets/pcm-capture.js`
- `apps/console/scripts/dev-fresh.sh`
- `apps/console/src/core/argument-heal.ts`
- `apps/console/src/core/fuzzy.ts`
- `apps/console/src/core/math-delims.ts`
- `apps/console/src/core/prices.ts`
- `apps/console/src/core/session-find.ts`
- `apps/console/src/core/value-debris.ts`
- `apps/console/src/server/keys.ts`
- `apps/console/src/store/auth.ts`
- `apps/console/src/store/jobs.ts`
- `apps/console/src/store/prompt-overrides.ts`
- `apps/console/src/store/settings.ts`
- `apps/console/tests/auth-store.test.ts`
- `apps/console/tests/backdrop-dismiss.test.ts`
- `apps/console/tests/byok-refusal.test.ts`
- `apps/console/tests/dictation-warm.test.ts`
- `apps/console/tests/dock-state-key.test.ts`
- `apps/console/tests/fixtures/golden-data/chats/chat_mv27rrra_feff23b6.json`
- `apps/console/tests/fixtures/golden-data/chats/chat_mv293wv5_10656952.json`
- `apps/console/tests/fixtures/golden-data/graph/render-settings.json`
- `apps/console/tests/fixtures/golden-data/jobs/job_murepie2_9d791321.json`
- `apps/console/tests/fixtures/golden-data/jobs/job_mux5xn7v_b49f3458.json`
- `apps/console/tests/fixtures/golden-data/jobs/job_mv282vv0_e7b89c9b.json`
- `apps/console/tests/fixtures/golden-data/jobs/job_mv28p0fs_0a16b76e.json`
- `apps/console/tests/fixtures/golden-data/jobs/job_mv28tfii_2a54290a.json`
- `apps/console/tests/fixtures/golden-data/settings.json`
- `apps/console/tests/font-menu.test.tsx`
- `apps/console/tests/fresh-env-keys.test.ts`
- `apps/console/tests/fuzzy.test.ts`
- `apps/console/tests/katex-security.test.ts`
- `apps/console/tests/keyboard-toggle-sidebar.test.ts`
- `apps/console/tests/menu-shell-pure.test.ts`
- `apps/console/tests/openrouter-free-models.test.ts`
- `apps/console/tests/pan-zoom.test.ts`
- `apps/console/tests/prices-sync.test.ts`
- `apps/console/tests/render-markdown.test.tsx`
- `apps/console/tests/render-update-banner.test.tsx`
- `apps/console/tests/server-events.test.tsx`
- `apps/console/tests/server-keys.test.ts`
- `apps/console/tests/session-find.test.tsx`
- `apps/console/tests/settings-signal.test.ts`
- `apps/console/tests/title-from-prompt.test.ts`
- `apps/console/tests/tooltip-mechanism.test.tsx`
- `apps/console/tsconfig.json`
- `apps/desktop/build/background.png`
- `apps/desktop/build/background@2x.png`
- `apps/desktop/build/entitlements.mac.plist`
- `apps/desktop/build/icon-flat.svg`
- `apps/desktop/build/icon.icns`
- `apps/desktop/build/icon.ico`
- `apps/desktop/build/icon.icon/Assets/lh_0 2.svg`
- `apps/desktop/build/icon.icon/Assets/lh_1 2.svg`
- `apps/desktop/build/icon.icon/Assets/lh_2 2.svg`
- `apps/desktop/build/icon.icon/icon.json`
- `apps/desktop/build/icon.png`
- `apps/desktop/scripts/after-pack.cjs`
- `apps/desktop/scripts/make-icons.mjs`

</details>

<details><summary>(b) Copied, modified (lines added / deleted vs upstream, upstream line count)</summary>

- `apps/console/.gitignore` (+3 / -0 of 18)
- `apps/console/AGENTS.md` (+1 / -1 of 15)
- `apps/console/README.md` (+18 / -65 of 78)
- `apps/console/app/api/graph/positions/route.ts` (+23 / -11 of 24)
- `apps/console/app/api/settings/prompts/route.ts` (+2 / -3 of 29)
- `apps/console/app/chat/new/page.tsx` (+12 / -24 of 30)
- `apps/console/app/layout.tsx` (+22 / -10 of 41)
- `apps/console/components/ai-elements/message.tsx` (+33 / -3 of 407)
- `apps/console/components/ai-elements/reasoning.tsx` (+6 / -1 of 221)
- `apps/console/components/answered-card.tsx` (+12 / -27 of 234)
- `apps/console/components/braille-spinner.tsx` (+5 / -2 of 68)
- `apps/console/components/chat.tsx` (+99 / -621 of 2376)
- `apps/console/components/composer.tsx` (+144 / -105 of 162)
- `apps/console/components/dictation.tsx` (+188 / -9 of 747)
- `apps/console/components/graph-canvas.ts` (+585 / -261 of 1737)
- `apps/console/components/graph-view.tsx` (+429 / -1521 of 1715)
- `apps/console/components/md-blocks.tsx` (+167 / -1 of 472)
- `apps/console/components/question-dock.tsx` (+26 / -95 of 913)
- `apps/console/components/server-events.tsx` (+28 / -0 of 155)
- `apps/console/components/session-core.ts` (+277 / -65 of 745)
- `apps/console/components/session-overlay.tsx` (+12 / -41 of 334)
- `apps/console/components/session.ts` (+18 / -10 of 142)
- `apps/console/components/settings/agent-section.tsx` (+54 / -345 of 924)
- `apps/console/components/settings/appearance-section.tsx` (+2 / -95 of 428)
- `apps/console/components/settings/settings-dialog.tsx` (+2 / -18 of 446)
- `apps/console/components/sidebar.tsx` (+251 / -150 of 935)
- `apps/console/config.ts` (+5 / -46 of 145)
- `apps/console/docs/desktop-release.md` (+2 / -0 of 98)
- `apps/console/docs/keyboard.md` (+4 / -1 of 105)
- `apps/console/next.config.ts` (+1 / -25 of 88)
- `apps/console/package.json` (+13 / -27 of 94)
- `apps/console/scripts/sync-pricing.ts` (+4 / -7 of 121)
- `apps/console/src/agent/models.ts` (+0 / -13 of 132)
- `apps/console/src/agent/prompt-segments.ts` (+18 / -73 of 134)
- `apps/console/src/agent/system-prompt.md` (+1 / -11 of 11)
- `apps/console/src/core/auth-keys.ts` (+2 / -21 of 204)
- `apps/console/src/core/compaction.ts` (+16 / -58 of 395)
- `apps/console/src/core/contracts.ts` (+3 / -6 of 18)
- `apps/console/src/core/contracts/chat.ts` (+9 / -160 of 319)
- `apps/console/src/core/contracts/graph.ts` (+6 / -344 of 385)
- `apps/console/src/core/contracts/jobs.ts` (+47 / -220 of 431)
- `apps/console/src/core/contracts/models.ts` (+2 / -15 of 85)
- `apps/console/src/core/events.ts` (+21 / -0 of 109)
- `apps/console/src/core/index.ts` (+42 / -26 of 77)
- `apps/console/src/core/input-events.ts` (+11 / -94 of 249)
- `apps/console/src/core/keyboard.ts` (+4 / -2 of 219)
- `apps/console/src/core/layout.ts` (+100 / -256 of 720)
- `apps/console/src/core/native-messages.ts` (+19 / -375 of 720)
- `apps/console/src/core/pending.ts` (+5 / -69 of 174)
- `apps/console/src/core/ports.ts` (+2 / -81 of 222)
- `apps/console/src/core/prompt-segments.ts` (+13 / -22 of 50)
- `apps/console/src/core/question-core.ts` (+2 / -25 of 787)
- `apps/console/src/core/render-settings.ts` (+40 / -14 of 394)
- `apps/console/src/core/session-navigation.ts` (+0 / -8 of 47)
- `apps/console/src/core/settings-resolution.ts` (+3 / -118 of 256)
- `apps/console/src/core/settings.ts` (+16 / -176 of 644)
- `apps/console/src/core/tool-parts.ts` (+0 / -6 of 139)
- `apps/console/src/core/view.ts` (+69 / -104 of 457)
- `apps/console/src/server/compaction.ts` (+3 / -11 of 301)
- `apps/console/src/server/events-stream.ts` (+24 / -1 of 81)
- `apps/console/src/server/index.ts` (+9 / -4 of 45)
- `apps/console/src/server/model-catalog.ts` (+2 / -32 of 303)
- `apps/console/src/server/settings-body.ts` (+6 / -111 of 390)
- `apps/console/src/server/stores.ts` (+1 / -3 of 34)
- `apps/console/src/store/chats.ts` (+26 / -55 of 219)
- `apps/console/src/store/render-settings.ts` (+0 / -3 of 43)
- `apps/console/tests/auth-keys.test.ts` (+6 / -19 of 109)
- `apps/console/tests/auth-provider-keys.test.ts` (+7 / -2 of 92)
- `apps/console/tests/chat-store-events.test.ts` (+1 / -3 of 77)
- `apps/console/tests/compaction-service.test.ts` (+0 / -1 of 206)
- `apps/console/tests/compaction.test.ts` (+7 / -27 of 430)
- `apps/console/tests/data-dir-seam.test.ts` (+3 / -2 of 50)
- `apps/console/tests/desktop-payload.test.ts` (+15 / -11 of 96)
- `apps/console/tests/desktop-platform.test.ts` (+11 / -8 of 258)
- `apps/console/tests/esc-layering.test.ts` (+2 / -13 of 52)
- `apps/console/tests/events.test.ts` (+3 / -0 of 131)
- `apps/console/tests/fixtures/golden-data/README.md` (+3 / -5 of 47)
- `apps/console/tests/golden-fixtures.test.ts` (+7 / -88 of 231)
- `apps/console/tests/graph-canvas.test.ts` (+78 / -124 of 416)
- `apps/console/tests/layout.test.ts` (+80 / -321 of 490)
- `apps/console/tests/mac-signing-toolchain.test.ts` (+3 / -2 of 124)
- `apps/console/tests/model-catalog.test.ts` (+0 / -38 of 329)
- `apps/console/tests/prompt-overrides.test.ts` (+75 / -167 of 432)
- `apps/console/tests/question-core.test.ts` (+5 / -28 of 821)
- `apps/console/tests/render-cards.test.tsx` (+14 / -191 of 777)
- `apps/console/tests/render-composer.test.tsx` (+2 / -36 of 118)
- `apps/console/tests/render-graph-chrome.test.tsx` (+9 / -21 of 70)
- `apps/console/tests/render-md-blocks.test.tsx` (+20 / -18 of 274)
- `apps/console/tests/render-settings.test.ts` (+43 / -16 of 361)
- `apps/console/tests/render-settings.test.tsx` (+20 / -124 of 283)
- `apps/console/tests/render-sidebar.test.tsx` (+45 / -53 of 163)
- `apps/console/tests/schema-stamps.test.ts` (+3 / -46 of 117)
- `apps/console/tests/session-context.test.tsx` (+5 / -35 of 128)
- `apps/console/tests/session-core.test.ts` (+44 / -45 of 1115)
- `apps/console/tests/session-navigation.test.ts` (+5 / -23 of 84)
- `apps/console/tests/settings-body.test.ts` (+9 / -105 of 291)
- `apps/console/tests/settings-pure.test.ts` (+11 / -95 of 407)
- `apps/console/tests/settings-resolution.test.ts` (+12 / -175 of 270)
- `apps/console/tests/settings-store.test.ts` (+4 / -4 of 76)
- `apps/console/tests/settings.test.ts` (+11 / -84 of 216)
- `apps/console/tests/stream-activity.test.ts` (+1 / -2 of 59)
- `apps/console/tests/tool-parts.test.ts` (+0 / -38 of 480)
- `apps/console/tests/usage.test.ts` (+2 / -71 of 307)
- `apps/console/tests/zero-keys.test.tsx` (+0 / -7 of 164)
- `apps/desktop/electron-builder.yml` (+3 / -3 of 184)
- `apps/desktop/electron/main.cjs` (+65 / -71 of 610)
- `apps/desktop/electron/preload.cjs` (+12 / -0 of 45)
- `apps/desktop/scripts/build-server.mjs` (+9 / -8 of 91)
- `apps/desktop/scripts/smoke-server.mjs` (+20 / -7 of 188)

</details>

<details><summary>(c) New in wolfpack</summary>

- `apps/console/app/(home)/kb/entry/[id]/page.tsx`
- `apps/console/app/(home)/layout.tsx`
- `apps/console/app/(home)/page.tsx`
- `apps/console/app/api/needs-you/route.ts`
- `apps/console/app/api/wolves/[name]/events/route.ts`
- `apps/console/app/api/wolves/[name]/kb/entries/[id]/route.ts`
- `apps/console/app/api/wolves/[name]/kb/graph/route.ts`
- `apps/console/app/api/wolves/[name]/kb/pipeline/route.ts`
- `apps/console/app/api/wolves/[name]/memory/consolidate/route.ts`
- `apps/console/app/api/wolves/[name]/memory/observations/route.ts`
- `apps/console/app/api/wolves/[name]/memory/promote/route.ts`
- `apps/console/app/api/wolves/[name]/memory/route.ts`
- `apps/console/app/api/wolves/[name]/memory/topics/[id]/route.ts`
- `apps/console/app/api/wolves/[name]/threads/[slug]/abort/route.ts`
- `apps/console/app/api/wolves/[name]/threads/[slug]/attachments/[attachmentId]/route.ts`
- `apps/console/app/api/wolves/[name]/threads/[slug]/attachments/route.ts`
- `apps/console/app/api/wolves/[name]/threads/[slug]/bind/route.ts`
- `apps/console/app/api/wolves/[name]/threads/[slug]/cards/[callId]/answer/route.ts`
- `apps/console/app/api/wolves/[name]/threads/[slug]/cards/[callId]/skip/route.ts`
- `apps/console/app/api/wolves/[name]/threads/[slug]/children/route.ts`
- `apps/console/app/api/wolves/[name]/threads/[slug]/compact/route.ts`
- `apps/console/app/api/wolves/[name]/threads/[slug]/context/route.ts`
- `apps/console/app/api/wolves/[name]/threads/[slug]/ledger/route.ts`
- `apps/console/app/api/wolves/[name]/threads/[slug]/route.ts`
- `apps/console/app/api/wolves/[name]/threads/[slug]/settings/route.ts`
- `apps/console/app/api/wolves/[name]/threads/[slug]/stream/route.ts`
- `apps/console/app/api/wolves/[name]/threads/[slug]/submit/route.ts`
- `apps/console/app/api/wolves/[name]/threads/[slug]/workspace/graph/route.ts`
- `apps/console/app/api/wolves/[name]/threads/[slug]/workspace/route.ts`
- `apps/console/app/api/wolves/[name]/threads/route.ts`
- `apps/console/app/api/wolves/[name]/work/[id]/graduate/confirm/route.ts`
- `apps/console/app/api/wolves/[name]/work/[id]/graduate/observations/route.ts`
- `apps/console/app/api/wolves/[name]/work/[id]/graduate/preview/route.ts`
- `apps/console/app/api/wolves/[name]/work/[id]/graduate/status/route.ts`
- `apps/console/app/api/wolves/[name]/work/[id]/record/route.ts`
- `apps/console/app/api/wolves/[name]/work/route.ts`
- `apps/console/app/api/wolves/route.ts`
- `apps/console/app/kb/work/[id]/page.tsx`
- `apps/console/app/pair/page.tsx`
- `apps/console/app/pipeline/page.tsx`
- `apps/console/app/wolf/[name]/page.tsx`
- `apps/console/app/wolf/[name]/thread/[threadId]/page.tsx`
- `apps/console/components/ask-card.tsx`
- `apps/console/components/attachment-thumbs.tsx`
- `apps/console/components/attachments.ts`
- `apps/console/components/branch-graph.tsx`
- `apps/console/components/card-registry.tsx`
- `apps/console/components/checklist-card.tsx`
- `apps/console/components/command-palette.tsx`
- `apps/console/components/composer-controls.tsx`
- `apps/console/components/composer-settings.ts`
- `apps/console/components/decision-card.tsx`
- `apps/console/components/earlier-scroll.ts`
- `apps/console/components/entry-reader.tsx`
- `apps/console/components/feature-progress.tsx`
- `apps/console/components/graduate-client.ts`
- `apps/console/components/graduate-dialog.tsx`
- `apps/console/components/graduate-store.ts`
- `apps/console/components/graduation-signal.ts`
- `apps/console/components/graph-card.tsx`
- `apps/console/components/graph-home.tsx`
- `apps/console/components/graph-pane.tsx`
- `apps/console/components/graph-route-nav.tsx`
- `apps/console/components/graph-settings-panel.tsx`
- `apps/console/components/hub-auth.tsx`
- `apps/console/components/kb-client.ts`
- `apps/console/components/kb-markdown.tsx`
- `apps/console/components/memory-events.tsx`
- `apps/console/components/memory-panel.tsx`
- `apps/console/components/needs-you-notify.ts`
- `apps/console/components/needs-you.tsx`
- `apps/console/components/object-card.tsx`
- `apps/console/components/overlay-shell.tsx`
- `apps/console/components/panel-host.tsx`
- `apps/console/components/pinned-checklist.tsx`
- `apps/console/components/pipeline-client.ts`
- `apps/console/components/pipeline-view.tsx`
- `apps/console/components/plan-graph-card.tsx`
- `apps/console/components/plan-graph-view.tsx`
- `apps/console/components/speaker-colors.ts`
- `apps/console/components/subagent-message.tsx`
- `apps/console/components/subagent-modal.tsx`
- `apps/console/components/subagent-strip.tsx`
- `apps/console/components/task-graph.tsx`
- `apps/console/components/thinking-toggle.ts`
- `apps/console/components/thread-chat.tsx`
- `apps/console/components/thread-compaction-divider.tsx`
- `apps/console/components/thread-context.tsx`
- `apps/console/components/thread-git-tree.tsx`
- `apps/console/components/thread-transport.ts`
- `apps/console/components/tool-row.tsx`
- `apps/console/components/turn-timer.tsx`
- `apps/console/components/use-graph-settings.ts`
- `apps/console/components/use-kb-graph.ts`
- `apps/console/components/use-librarian.ts`
- `apps/console/components/work-badges.tsx`
- `apps/console/components/work-client.ts`
- `apps/console/components/work-id-chip.tsx`
- `apps/console/components/work-item-page.tsx`
- `apps/console/components/work-view-entry.tsx`
- `apps/console/components/work-view.tsx`
- `apps/console/lib/composer-draft.ts`
- `apps/console/scripts/test.sh`
- `apps/console/src/core/branch-graph.ts`
- `apps/console/src/core/coalesced-refresh.ts`
- `apps/console/src/core/dep-draw-list.ts`
- `apps/console/src/core/dep-palette.ts`
- `apps/console/src/core/dep-route-adapter.ts`
- `apps/console/src/core/entry-view.ts`
- `apps/console/src/core/escape-html.ts`
- `apps/console/src/core/feature-progress.ts`
- `apps/console/src/core/graduate.ts`
- `apps/console/src/core/graph-activity.ts`
- `apps/console/src/core/graph-layout.ts`
- `apps/console/src/core/graph-pane.ts`
- `apps/console/src/core/graph-persistence.ts`
- `apps/console/src/core/hub-auth.ts`
- `apps/console/src/core/item-document.ts`
- `apps/console/src/core/kb-graph-model.ts`
- `apps/console/src/core/kb.ts`
- `apps/console/src/core/memory-panel-model.ts`
- `apps/console/src/core/needs-you.ts`
- `apps/console/src/core/objects.ts`
- `apps/console/src/core/palette.ts`
- `apps/console/src/core/panel-host.ts`
- `apps/console/src/core/pipeline-model.ts`
- `apps/console/src/core/route-layout.ts`
- `apps/console/src/core/subagent-message.ts`
- `apps/console/src/core/subagents.ts`
- `apps/console/src/core/task-graph-layout.ts`
- `apps/console/src/core/task-graph.ts`
- `apps/console/src/core/thread-adapter.ts`
- `apps/console/src/core/thread-cards.ts`
- `apps/console/src/core/thread-lists.ts`
- `apps/console/src/core/tool-rows.ts`
- `apps/console/src/core/work-connectors.ts`
- `apps/console/src/core/work-id-link.ts`
- `apps/console/src/core/work-route.ts`
- `apps/console/src/core/work-select.ts`
- `apps/console/src/core/work-table.ts`
- `apps/console/src/core/work-view.ts`
- `apps/console/src/server/branch-graph.ts`
- `apps/console/src/server/console-client.ts`
- `apps/console/src/server/graph-positions.ts`
- `apps/console/src/server/memory-api.ts`
- `apps/console/src/server/needs-you-api.ts`
- `apps/console/src/server/pipeline-api.ts`
- `apps/console/src/server/thread-api.ts`
- `apps/console/src/store/graph-positions.ts`
- `apps/console/tests/ask-card-kinds.test.tsx`
- `apps/console/tests/ask-card-optional.test.tsx`
- `apps/console/tests/ask-card-other.test.tsx`
- `apps/console/tests/ask-card-ship.test.tsx`
- `apps/console/tests/ask-card-steps.test.tsx`
- `apps/console/tests/branch-graph.test.ts`
- `apps/console/tests/card-registry.test.tsx`
- `apps/console/tests/coalesced-refresh.test.ts`
- `apps/console/tests/composer-controls.test.tsx`
- `apps/console/tests/composer-draft.test.tsx`
- `apps/console/tests/console-client.test.ts`
- `apps/console/tests/dep-routes-render.test.ts`
- `apps/console/tests/desktop-remote.test.ts`
- `apps/console/tests/dictation-store-notify.test.tsx`
- `apps/console/tests/entry-view.test.ts`
- `apps/console/tests/escape-raw-html.test.tsx`
- `apps/console/tests/feature-progress.test.tsx`
- `apps/console/tests/feature-ready-label.test.ts`
- `apps/console/tests/feature-threads.test.tsx`
- `apps/console/tests/git-tree.test.tsx`
- `apps/console/tests/graduate.test.tsx`
- `apps/console/tests/graph-activity.test.ts`
- `apps/console/tests/graph-layout.test.ts`
- `apps/console/tests/graph-pane.test.tsx`
- `apps/console/tests/graph-persistence.test.ts`
- `apps/console/tests/graph-route.test.tsx`
- `apps/console/tests/graph-work-depth.test.ts`
- `apps/console/tests/helpers/thread-fetch.ts`
- `apps/console/tests/hub-auth.test.ts`
- `apps/console/tests/inline-mic.test.tsx`
- `apps/console/tests/item-document.test.ts`
- `apps/console/tests/kb-core.test.ts`
- `apps/console/tests/kb-graph-model.test.ts`
- `apps/console/tests/live-bridge-real-wolf.test.ts`
- `apps/console/tests/memory-api.test.ts`
- `apps/console/tests/memory-bind.test.tsx`
- `apps/console/tests/memory-events-hub.test.ts`
- `apps/console/tests/memory-panel-model.test.ts`
- `apps/console/tests/memory-panel-observations.test.tsx`
- `apps/console/tests/needs-you.test.ts`
- `apps/console/tests/observation-groups.test.ts`
- `apps/console/tests/overlay-shell.test.tsx`
- `apps/console/tests/palette.test.ts`
- `apps/console/tests/panel-host.test.tsx`
- `apps/console/tests/pipeline-api.test.ts`
- `apps/console/tests/pipeline-model.test.ts`
- `apps/console/tests/plan-graph-click.test.tsx`
- `apps/console/tests/plan-graph.test.tsx`
- `apps/console/tests/render-entry-reader.test.tsx`
- `apps/console/tests/render-graph-card.test.tsx`
- `apps/console/tests/render-memory-panel.test.tsx`
- `apps/console/tests/render-needs-you.test.tsx`
- `apps/console/tests/render-pipeline-view.test.tsx`
- `apps/console/tests/render-subagent-modal.test.tsx`
- `apps/console/tests/render-task-graph.test.tsx`
- `apps/console/tests/route-layout.test.ts`
- `apps/console/tests/route-same-nodes.test.ts`
- `apps/console/tests/structured-objects.test.tsx`
- `apps/console/tests/subagent-modal-dup.test.tsx`
- `apps/console/tests/subagent-strip.test.tsx`
- `apps/console/tests/task-graph-layout.test.ts`
- `apps/console/tests/task-graph.test.ts`
- `apps/console/tests/thread-adapter.test.ts`
- `apps/console/tests/thread-api-cards.test.ts`
- `apps/console/tests/thread-api.test.ts`
- `apps/console/tests/thread-attachments-ui.test.tsx`
- `apps/console/tests/thread-attachments.test.tsx`
- `apps/console/tests/thread-chat-card.test.tsx`
- `apps/console/tests/thread-chat-dictation.test.tsx`
- `apps/console/tests/thread-chat-draft.test.tsx`
- `apps/console/tests/thread-chat-live-real-wolf.test.tsx`
- `apps/console/tests/thread-chat-live.test.tsx`
- `apps/console/tests/thread-chat-subagent-message.test.tsx`
- `apps/console/tests/thread-chat-thinking.test.tsx`
- `apps/console/tests/thread-closed.test.tsx`
- `apps/console/tests/thread-compaction-divider.test.tsx`
- `apps/console/tests/thread-context.test.tsx`
- `apps/console/tests/thread-lists.test.ts`
- `apps/console/tests/thread-steer.test.ts`
- `apps/console/tests/tool-keys.test.ts`
- `apps/console/tests/tool-rows.test.tsx`
- `apps/console/tests/transcript-paging.test.ts`
- `apps/console/tests/turn-timers.test.tsx`
- `apps/console/tests/work-connectors.test.ts`
- `apps/console/tests/work-id-chip.test.tsx`
- `apps/console/tests/work-reader-overlay.test.tsx`
- `apps/console/tests/work-route.test.ts`
- `apps/console/tests/work-select.test.ts`
- `apps/console/tests/work-table.test.ts`
- `apps/console/tests/work-view-select.test.tsx`
- `apps/console/tests/work-view.test.ts`
- `apps/console/tests/work-view.test.tsx`
- `apps/desktop/README.md`
- `apps/desktop/electron/notify.cjs`
- `apps/desktop/electron/remote.cjs`
- `apps/desktop/package.json`

</details>

<details><summary>Upstream files removed (paths in upstream)</summary>

- `LICENSE`
- `app/api/chats/[id]/artifact-ui/route.ts`
- `app/api/graph/costs/route.ts`
- `app/api/graph/coverage/extract/route.ts`
- `app/api/graph/import/route.ts`
- `app/api/graph/nodes/[id]/route.ts`
- `app/api/graph/route.ts`
- `app/api/graph/status/route.ts`
- `app/api/keys/[id]/route.ts`
- `app/api/keys/route.ts`
- `app/api/search/route.ts`
- `app/chat/[id]/page.tsx`
- `app/page.tsx`
- `components/artifacts/demo-card.tsx`
- `components/artifacts/download.ts`
- `components/artifacts/index.ts`
- `components/artifacts/invert-disc.tsx`
- `components/artifacts/probe-done-card.tsx`
- `components/artifacts/visual-card.tsx`
- `components/chain-table.tsx`
- `components/delete-node-dialog.tsx`
- `components/extraction-coverage.tsx`
- `components/graph-context-card.tsx`
- `components/home.tsx`
- `components/minimal-home.tsx`
- `components/notes-import.tsx`
- `components/phase-divider.tsx`
- `components/plan-window.tsx`
- `components/practice-cards.tsx`
- `components/practice-dock.tsx`
- `components/reading-thinking.tsx`
- `docs/architecture.md`
- `docs/archive/architecture-2026-09-08.md`
- `docs/assets/knowledge-graph.png`
- `docs/assets/lh_banner_dark.png`
- `docs/assets/lh_banner_dark.svg`
- `docs/assets/lh_banner_light.png`
- `docs/assets/lh_banner_light.svg`
- `docs/assets/teaching-session.png`
- `docs/development.md`
- `docs/pi-engine-swap.md`
- `docs/plan.md`
- `docs/probe-teach-split.md`
- `docs/release-0.3.md`
- `docs/teaching-methodology.md`
- `docs/vision.md`
- `electron/browser-service-readiness.cjs`
- `next-env.d.ts`
- `package-lock.json`
- `scripts/backfill-graph.ts`
- `scripts/import-notes.ts`
- `scripts/replay-layout.ts`
- `scripts/smoke-demo-runtime.mjs`
- `scripts/verify-release.ts`
- `skills/learnharness/LICENSE`
- `skills/learnharness/SKILL.md`
- `skills/learnharness/references/data-format.md`
- `skills/learnharness/scripts/_data.py`
- `skills/learnharness/scripts/graph.py`
- `skills/learnharness/scripts/sessions.py`
- `src/agent/prompts/README.md`
- `src/agent/prompts/practice/00-base.md`
- `src/agent/prompts/practice/10-doctrine.md`
- `src/agent/prompts/prober/10-probe-doctrine.md`
- `src/agent/prompts/shared/10-voice.md`
- `src/agent/prompts/shared/15-accuracy.md`
- `src/agent/prompts/shared/16-mental-model.md`
- `src/agent/prompts/shared/20-question-tools.md`
- `src/agent/prompts/shared/25-confidence.md`
- `src/agent/prompts/shared/30-learner-files.md`
- `src/agent/prompts/shared/40-formatting.md`
- `src/agent/prompts/teacher/05-method.md`
- `src/agent/prompts/teacher/10-planning.md`
- `src/agent/prompts/teacher/20-teaching.md`
- `src/agent/prompts/teacher/28-predictions.md`
- `src/agent/prompts/teacher/30-question-principles.md`
- `src/agent/prompts/teacher/40-jobs.md`
- `src/agent/prompts/teacher/50-demos.md`
- `src/agent/subagents/bg-llm-semaphore.ts`
- `src/agent/subagents/demo-builder.ts`
- `src/agent/subagents/extraction.ts`
- `src/agent/subagents/headless.ts`
- `src/agent/subagents/pdf-ops.ts`
- `src/agent/subagents/pdf-reader.ts`
- `src/agent/subagents/researcher.ts`
- `src/agent/subagents/runner.ts`
- `src/agent/subagents/submit-agent.ts`
- `src/agent/subagents/visual-maker.ts`
- `src/agent/teacher-agent.ts`
- `src/agent/tools.ts`
- `src/agent/tools/graph.ts`
- `src/agent/tools/jobs.ts`
- `src/agent/tools/mermaid-plan.ts`
- `src/agent/tools/pdf-read.ts`
- `src/agent/tools/plan.ts`
- `src/agent/tools/practice.ts`
- `src/agent/tools/probe.ts`
- `src/agent/tools/web.ts`
- `src/core/chains.ts`
- `src/core/clusters.ts`
- `src/core/contracts/plan.ts`
- `src/core/contracts/probe.ts`
- `src/core/cost-summary.ts`
- `src/core/coverage.ts`
- `src/core/graph-deletion.ts`
- `src/core/graph.ts`
- `src/core/layout-settle.ts`
- `src/core/phases.ts`
- `src/core/plan-blocks.ts`
- `src/core/plan-tree.ts`
- `src/core/search.ts`
- `src/core/session-clusters.ts`
- `src/server/commit-positions.ts`
- `src/server/graph.ts`
- `src/server/search.ts`
- `src/store/graph-format.ts`
- `src/store/graph.ts`
- `tests/artifact-ui.test.ts`
- `tests/browser-service-lifetime.test.ts`
- `tests/browser-service-readiness.test.ts`
- `tests/browser-service.test.ts`
- `tests/chat-kind.test.ts`
- `tests/clusters.test.ts`
- `tests/commit-positions.test.ts`
- `tests/cost-summary.test.ts`
- `tests/coverage.test.ts`
- `tests/delete-node-dialog.test.tsx`
- `tests/demo-runtime-payload.test.ts`
- `tests/demos.test.tsx`
- `tests/extraction.test.ts`
- `tests/fixtures/golden-data/graph/chains.jsonl`
- `tests/fixtures/golden-data/graph/coverage.jsonl`
- `tests/fixtures/golden-data/graph/nodes.jsonl`
- `tests/fixtures/golden-data/graph/positions.json`
- `tests/fixtures/golden-data/graph/sessions.jsonl`
- `tests/fixtures/golden-data/graph/sources.json`
- `tests/fixtures/not-a-pdf.txt`
- `tests/fixtures/sample-3page.pdf`
- `tests/graph-context.test.ts`
- `tests/graph-rename-labels.test.ts`
- `tests/graph-tools.test.ts`
- `tests/graph-view-filters.test.ts`
- `tests/graph.test.ts`
- `tests/headless-png.test.ts`
- `tests/notes-import-route.test.ts`
- `tests/notes-import.test.tsx`
- `tests/pdf-native-render.test.ts`
- `tests/pdf-ops.test.ts`
- `tests/pdf-reader.test.ts`
- `tests/phases.test.ts`
- `tests/plan-blocks.test.ts`
- `tests/plan-tree.test.ts`
- `tests/plan-window.test.tsx`
- `tests/practice-agents.test.ts`
- `tests/practice-flow.test.ts`
- `tests/practice-heal.test.ts`
- `tests/practice-record.test.ts`
- `tests/probe-done.test.ts`
- `tests/question-tools.test.ts`
- `tests/reading-thinking-field.test.tsx`
- `tests/render-chain-table.test.tsx`
- `tests/render-extraction-coverage.test.tsx`
- `tests/render-minimal-home.test.tsx`
- `tests/render-phase-divider.test.tsx`
- `tests/render-practice-surface.test.tsx`
- `tests/researcher-pdf.test.ts`
- `tests/reveal-arrival.test.ts`
- `tests/search.test.ts`
- `tests/session-clusters.test.ts`
- `tests/skills/README.md`
- `tests/skills/test_data_helpers.py`
- `tests/skills/test_graph.py`
- `tests/skills/test_sessions.py`
- `tests/skills/test_skill.py`
- `tests/svg-native-render.test.ts`
- `tests/tool-toggles-bridge.test.ts`
- `tests/verify-release.test.ts`
- `tests/web-search.test.ts`

</details>
