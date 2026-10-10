# KB Knowledge Graph

Backs the `/kb` command in the wolfpack-memory extension (`index.ts`), which runs
this script and opens the result. Work items in the Factory area are colored by
kind, and completed ones (shipped/live/archived) share one muted color.

Generates a self-contained HTML page that shows the librarian-curated knowledge
base as an interactive node graph, and opens it in the default browser. The page
has three parts:

- A **KB selector** dropdown (one option per domain, e.g. Wolfpack / Snapjack) —
  this is the "select a knowledge base" step; switching it re-renders the graph.
- A row of **filter dropdowns** — `kind`, `maturity`, `authority`, `currency`,
  `subsystem`, `layer`, `lifecycle`. Each defaults to "all" and is populated from
  the values actually present in the selected KB; pick a value to show only
  matching entries (and the sections that still contain them). A **Reset filters**
  button clears them. The counter shows `shown / total` while filters are active.
- The **graph**: `domain → sections → entries`. Entries are colored by maturity
  (live / stub / draft / deprecated).
- A collapsible **markdown panel** on the right. Clicking any node renders that
  entry's content and metadata (kind, maturity, authority, currency, facets).
  The **Hide panel / Show panel** button in the top bar toggles it so you can go
  graph-only.

## How it works

The KB lives on the laptop as a read-only Syncthing mirror at
`~/wolves/knowledge/base/` with `domains/<domain>/` folders containing
`_digest.json` (section tree + entry membership) and `entries/*.md`
(frontmatter + markdown body). The generator reads these, embeds everything into
one HTML file, and opens it. Nothing is written back to the KB.

Graph edges come from KB structure (section tree + entry→section placement).
Typed relations (`see_also`, `depends_on`, etc.) are not drawn yet because
entries do not currently populate a `relations:` field — if that changes, extend
`build_graph.py` to add those edges.

## Run it

```bash
python3 -I extensions/wolfpack-memory/kb-graph/build_graph.py
```

This builds `~/.cache/kb-graph/kb-graph.html` and opens it. Re-run any time to
pick up KB changes (the KB syncs continuously).

Options:

- `--kb-root DIR` — point at a different KB root (default `~/wolves/knowledge/base`).
- `--out FILE` — output path (default `~/.cache/kb-graph/kb-graph.html`).
- `--no-open` — build only, don't launch the browser.

## Notes

- The page loads `vis-network` and `marked` from CDNs, so it needs internet the
  first time a browser opens it. The graph data itself is fully embedded.
- If no domains are found, check that the Syncthing mirror is present and synced
  at `~/wolves/knowledge/base/domains/`.
