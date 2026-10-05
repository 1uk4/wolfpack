# Domain Proposal
*Generated from reading ~/Code/wolfpack/knowledge/snapjack/ — 95 files*

---

## Summary

All existing content is Snapjack-focused. No content currently exists for `wolfpack` or `personal` domains — those start empty. One external business reference (`Alventra`) in the marketing files is the only signal that a `business` domain will eventually be needed.

---

## Proposed starting domains

### `snapjack` ✅ warranted now
Everything Snapjack. Within it, five natural sub-categories (these are NOT separate domains — they are the folder shape inside `knowledge/base/domains/snapjack/entries/`):

| Sub-category | What belongs there | Current source |
|---|---|---|
| `product` | Technical system docs — how the app works, models, API, algorithms | `systems/*/`, `api/` |
| `bi` | Metric definitions, data dictionary, population filters, analytics caveats | `bi/`, `now/Business State.md` |
| `marketing` | ASO, app store copy, competitive landscape, campaigns | `marketing/`, `systems/marketing/` |
| `legal` | Privacy policy, terms of service, compliance | `systems/legal/` |
| `state` | Current live state of the app and business — rewritten in place | `now/App State.md`, `now/Business State.md` |

### `wolfpack` ✅ warranted now (starts empty)
Pack infrastructure — wolves, roles, capabilities, how the system works. No existing files to migrate. Will grow as Forge and the Librarian do their work.

### `personal` ✅ warranted now (starts empty)
Context about 1uk4 — preferences, routines, relationships, decisions. No existing files to migrate. Will grow from Hal's submissions and your own Mac-side session submissions.

### `business` 🔒 threshold-gated
General business operations that span multiple ventures. One file references Alventra (`marketing/ASO Launch Strategy.md` cites a local SEO playbook from Alventra). This is the signal — when 3+ claims arrive that don't fit `snapjack`, `wolfpack`, or `personal`, this domain gets proposed.

### `finances` 🔒 threshold-gated
Financial knowledge — accounts, rules, obligations, decisions across businesses. Nothing currently warrants it. Will emerge when you start submitting financial context via `/kb:submit`.

---

## What survives migration (high-value content)

These files are authoritative, verified against source, and clearly KB-worthy:

| File | Why it's valuable |
|---|---|
| `now/App State.md` | Complete current-state of the app, verified against commit `22b1d06`. Ground truth for what features exist. |
| `now/Business State.md` | Metric registry with trust levels, population filter warnings, revenue state. Verified. |
| `bi/Snapjack Data Dictionary.md` | BI schema reference — model grain, exclusion filters, traps. Essential for any analytics work. |
| `systems/settlements/Settlement System.md` | The most complex algorithm in the product. Well-documented. |
| `systems/auth/Auth System.md` | JWT architecture, security monitoring, dual-layer middleware. |
| `systems/rating/Rating System.md` | Glicko-2 implementation details, tier structure. |
| `systems/leagues/Leagues.md` | League system — the monetization mechanism. |
| `systems/game-tracking/Game Session System.md` | Event sourcing architecture. |
| `systems/legal/Privacy Policy.md` + `Terms of Service.md` | Legal docs — need stable entries. |
| `systems/monetization/Monetization.md` | Current paywall state, RevenueCat setup, known gaps. |

---

## What does NOT survive (low-value or wrong format for KB)

| File | Why to drop or not migrate |
|---|---|
| `changelog/*` and `systems/*/changelog.md` files | Append-only history logs — not KB entries. History lives in git. |
| `bi/github-open-issues-archive-2026-08-30.md` | Archive of deleted GitHub issues. Pure history. |
| `bi/ideas/` | Ideas/proposals — not facts or decisions. Not KB material. |
| `snapjack-analysis.md` | Pre-launch analysis from Feb 2026. Marked `sapling`. Most of it is now superseded by actual shipped state in `App State.md`. |
| `marketing/discord-poker-servers-2026-04-27.md` | Dated list of Discord servers. Stale. |
| `design/Design Inspiration.md` | Design references — subjective, doesn't age well as KB knowledge. |
| `systems/community/logs/2026-04.md` | Community activity log. History, not knowledge. |
| Anything with `status: sapling` | These are drafts/in-progress. Need verification before becoming curated entries. |

---

## Migration challenges

1. **Obsidian wiki-links** — `[[note name]]` throughout. Need to become explicit file references in the new schema. The librarian will need to resolve or strip these during migration.

2. **Dataview queries** — several files contain `dataview` code blocks that generate dynamic lists. These become static snapshots at migration time and will drift. Either remove or manually flatten.

3. **`status` field collision** — the existing files use Obsidian statuses (`sapling`, `evergreen`, `moc`) that need mapping to the new KB schema:
   - `evergreen` → `confidence: high`, `status: active`
   - `sapling` → `confidence: low`, `authority: claim` (not curated yet)
   - `moc` → these are index/navigation files, not KB entries — drop them

4. **State vs history confusion** — several files acknowledge this problem themselves (App State warns "don't add dated sections"). The new schema enforces this: entries are state, git is history.

5. **`verified_against` pattern** — `App State.md` and `Business State.md` track the git commit they were verified against. This maps to the `sources` field in the new schema.

---

## Recommended migration order

1. **Start with the 10 high-value files above** — these are clean, verified, and clearly curated
2. **Migrate `systems/` technical docs** — one entry per system, using the existing structure as a guide
3. **Skip changelogs entirely** — git history is the changelog
4. **Mark anything `sapling` as `authority: claim`** — it enters the new system as an unreviewed claim, the librarian assesses it
5. **Resolve Obsidian links at migration time** — replace `[[X]]` with the new entry ID once assigned

---

*This proposal should be reviewed before the Librarian's bootstrap migration task is written.*
