/**
 * Dashboard routes — serves the KB graph and dashboard data.
 *
 * GET /dashboard          → serves the HTML dashboard
 * GET /dashboard/api/kb   → KB data as JSON (domains, sections, entries)
 * GET /dashboard/api/work → Work items as JSON
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const KB_BASE = "/var/wolfpack/kb/base";

interface EntryData {
  id: string;
  title: string;
  domain: string;
  section?: string;
  kind?: string;
  maturity?: string;
  body: string;
}

interface SectionData {
  id: string;
  label: string;
  parent?: string;
}

interface DomainData {
  domain: string;
  label: string;
  sections: SectionData[];
  entries: EntryData[];
}

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      meta[key] = val;
    }
  }
  return { meta, body: match[2] };
}

function loadDomain(domainName: string): DomainData | null {
  const domainDir = join(KB_BASE, "domains", domainName);
  if (!existsSync(domainDir)) return null;

  // Read domain label from meta.yaml
  let label = domainName.charAt(0).toUpperCase() + domainName.slice(1);
  try {
    const metaFile = join(domainDir, "meta.yaml");
    if (existsSync(metaFile)) {
      const raw = readFileSync(metaFile, "utf-8");
      const m = raw.match(/label:\s*(.+)/);
      if (m) label = m[1].trim();
    }
  } catch { /* use default */ }

  // Read sections from _registry.md or _digest.json
  const sections: SectionData[] = [];
  try {
    const digestPath = join(domainDir, "_digest.json");
    if (existsSync(digestPath)) {
      const digest = JSON.parse(readFileSync(digestPath, "utf-8"));
      if (digest.sections) {
        for (const sec of digest.sections) {
          sections.push({
            id: sec.id,
            label: sec.label ?? sec.id,
            parent: sec.parent ?? undefined,
          });
        }
      }
    }
  } catch { /* no digest */ }

  // Read entries
  const entries: EntryData[] = [];
  const entriesDir = join(domainDir, "entries");
  if (existsSync(entriesDir)) {
    for (const f of readdirSync(entriesDir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const raw = readFileSync(join(entriesDir, f), "utf-8");
        const { meta, body } = parseFrontmatter(raw);
        entries.push({
          id: meta.id ?? f.replace(/\.md$/, ""),
          title: meta.title ?? f.replace(/\.md$/, ""),
          domain: domainName,
          section: meta.section,
          kind: meta.kind,
          maturity: meta.maturity,
          body,
        });
      } catch { continue; }
    }
  }

  return { domain: domainName, label, sections, entries };
}

export function dashboardRouter(): Router {
  const router = Router();

  // KB data API
  router.get("/api/kb", (_req: Request, res: Response) => {
    try {
      const domainsDir = join(KB_BASE, "domains");
      if (!existsSync(domainsDir)) {
        res.json({ domains: [] });
        return;
      }
      const domains: DomainData[] = [];
      for (const d of readdirSync(domainsDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const data = loadDomain(d.name);
        if (data) domains.push(data);
      }
      res.json({ domains });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Serve dashboard HTML
  router.get("/", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html");
    res.send(DASHBOARD_HTML);
  });

  return router;
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Wolfpack Dashboard</title>
<script src="https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js"></script>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background:#0f1115; color:#e6e6e6; height:100vh; overflow:hidden;
         display:flex; flex-direction:column; }
  header { display:flex; align-items:center; gap:12px; padding:10px 16px;
           background:#161922; border-bottom:1px solid #2d3340; flex-shrink:0; }
  header h1 { font-size:16px; margin:0; font-weight:600; }
  .btn { background:#1d2230; color:#c9d4e3; border:1px solid #2d3340; border-radius:6px;
         padding:5px 11px; font-size:12px; cursor:pointer; }
  .btn:hover { background:#252c3b; }
  .btn.active { background:#2563eb; border-color:#3b82f6; color:#fff; }
  select { background:#1d2230; color:#c9d4e3; border:1px solid #2d3340; border-radius:6px;
           padding:5px 8px; font-size:12px; }
  .container { display:flex; flex:1; overflow:hidden; }
  #graph { flex:1; }
  #panel { width:400px; background:#161922; border-left:1px solid #2d3340;
           overflow-y:auto; padding:16px; display:none; }
  #panel.open { display:block; }
  #panel h2 { font-size:14px; margin:0 0 8px; color:#93a3b8; }
  #panel .meta { font-size:12px; color:#64748b; margin-bottom:12px; }
  #panel .body { font-size:13px; line-height:1.6; }
  #panel .body h1, #panel .body h2, #panel .body h3 { color:#c9d4e3; }
  #panel .body code { background:#1e2433; padding:2px 5px; border-radius:3px; font-size:12px; }
  #panel .body pre { background:#1e2433; padding:12px; border-radius:6px; overflow-x:auto; }
  #panel .body a { color:#60a5fa; }
  #panel .body table { border-collapse:collapse; width:100%; margin:8px 0; }
  #panel .body td, #panel .body th { border:1px solid #2d3340; padding:4px 8px; font-size:12px; }
  .stats { font-size:11px; color:#64748b; margin-left:auto; }
</style>
</head>
<body>
<header>
  <h1>🐺 Wolfpack</h1>
  <select id="domainSelect"></select>
  <button class="btn" onclick="fitGraph()">Fit</button>
  <button class="btn" onclick="togglePanel()">Panel</button>
  <span class="stats" id="stats"></span>
</header>
<div class="container">
  <div id="graph"></div>
  <div id="panel">
    <h2 id="panelTitle"></h2>
    <div class="meta" id="panelMeta"></div>
    <div class="body" id="panelBody"></div>
  </div>
</div>
<script>
let network, allData = [], currentDomain = null;

async function loadData() {
  const res = await fetch('/dashboard/api/kb');
  const data = await res.json();
  allData = data.domains;
  const sel = document.getElementById('domainSelect');
  sel.innerHTML = allData.map(d =>
    '<option value="' + d.domain + '">' + d.label + ' (' + d.entries.length + ')</option>'
  ).join('');
  if (allData.length > 0) {
    currentDomain = allData[0].domain;
    renderGraph(allData[0]);
  }
  sel.addEventListener('change', () => {
    const d = allData.find(x => x.domain === sel.value);
    if (d) { currentDomain = d.domain; renderGraph(d); }
  });
}

function renderGraph(domainData) {
  const nodes = [];
  const edges = [];
  const colors = {
    domain: '#2563eb',
    section: '#059669',
    entry: '#64748b',
  };

  // Domain node
  nodes.push({
    id: domainData.domain,
    label: domainData.label,
    color: colors.domain,
    size: 30,
    font: { color: '#fff', size: 14, bold: true },
    shape: 'dot',
  });

  // Section nodes
  const sectionSet = new Set();
  for (const sec of domainData.sections) {
    sectionSet.add(sec.id);
    nodes.push({
      id: sec.id,
      label: sec.label,
      color: colors.section,
      size: 18,
      font: { color: '#e6e6e6', size: 11 },
      shape: 'dot',
    });
    edges.push({
      from: sec.parent || domainData.domain,
      to: sec.id,
      color: { color: '#2d3340' },
    });
  }

  // Entry nodes
  for (const entry of domainData.entries) {
    nodes.push({
      id: entry.id,
      label: entry.title.length > 40 ? entry.title.slice(0, 37) + '...' : entry.title,
      title: entry.title,
      color: colors.entry,
      size: 8,
      font: { color: '#93a3b8', size: 9 },
      shape: 'dot',
      _entry: entry,
    });
    const parent = entry.section && sectionSet.has(entry.section) ? entry.section : domainData.domain;
    edges.push({
      from: parent,
      to: entry.id,
      color: { color: '#1d2230' },
    });
  }

  const container = document.getElementById('graph');
  const data = { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) };
  const options = {
    physics: {
      solver: 'forceAtlas2Based',
      forceAtlas2Based: { gravitationalConstant: -40, centralGravity: 0.005, springLength: 80 },
      stabilization: { iterations: 150 },
    },
    interaction: { hover: true, tooltipDelay: 200 },
  };
  network = new vis.Network(container, data, options);

  network.on('click', (params) => {
    if (params.nodes.length === 0) return;
    const nodeId = params.nodes[0];
    const node = data.nodes.get(nodeId);
    if (node && node._entry) showEntry(node._entry);
  });

  document.getElementById('stats').textContent =
    domainData.sections.length + ' sections · ' + domainData.entries.length + ' entries';
}

function showEntry(entry) {
  document.getElementById('panelTitle').textContent = entry.title;
  document.getElementById('panelMeta').textContent =
    [entry.kind, entry.maturity, entry.section].filter(Boolean).join(' · ');
  document.getElementById('panelBody').innerHTML = marked.parse(entry.body || '');
  document.getElementById('panel').classList.add('open');
}

function togglePanel() {
  document.getElementById('panel').classList.toggle('open');
}

function fitGraph() {
  if (network) network.fit({ animation: true });
}

loadData();
</script>
</body>
</html>`;
