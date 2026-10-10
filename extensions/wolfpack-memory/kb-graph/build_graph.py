#!/usr/bin/env python3
"""Build a self-contained knowledge-graph HTML viewer from a wolfpack KB.

Reads a librarian-curated KB (domains/<domain>/ with _digest.json + entries/*.md),
builds one self-contained HTML file with:
  - a KB (domain) selector dropdown
  - an interactive node graph (domain -> sections -> entries)
  - a markdown panel on the right that renders the clicked entry

stdlib only. Safe to run with `python3 -I`.

Usage:
  python3 -I build_graph.py [--kb-root DIR] [--out FILE] [--no-open]
"""
from __future__ import annotations

import argparse
import html
import json
import os
import subprocess
import sys
import webbrowser
from pathlib import Path

DEFAULT_KB_ROOT = Path.home() / "wolves" / "knowledge" / "base"


def split_frontmatter(text: str):
    """Return (frontmatter_str, body_str). Frontmatter is the first --- block."""
    if text.startswith("---"):
        parts = text.split("\n---", 1)
        if len(parts) == 2:
            fm = parts[0][3:]  # drop leading ---
            body = parts[1].lstrip("\n")
            # body may still start right after the closing ---\n
            return fm, body
    return "", text


def parse_frontmatter(fm: str) -> dict:
    """Minimal YAML parse: top-level scalars, nested mappings, and lists.

    Handles the flat fields, simple nested maps (facets/properties), and
    lists (dependsOn, blocks) used by wolfpack KB entries.
    """
    meta: dict = {}
    current_key = None
    current_type = None  # 'dict' or 'list'
    for raw in fm.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        line = raw.strip()
        if indent == 0 and ":" in line:
            key, _, val = line.partition(":")
            key = key.strip()
            val = val.strip().strip('"')
            if val == "":
                # Could be dict or list - we'll detect on first child
                meta[key] = None
                current_key = key
                current_type = None
            else:
                meta[key] = val
                current_key = None
                current_type = None
        elif indent >= 2 and current_key:
            if line.startswith("- "):
                # It's a list item
                if meta[current_key] is None:
                    meta[current_key] = []
                    current_type = 'list'
                if current_type == 'list':
                    meta[current_key].append(line[2:].strip())
            elif ":" in line:
                # It's a dict entry
                if meta[current_key] is None:
                    meta[current_key] = {}
                    current_type = 'dict'
                if current_type == 'dict':
                    k, _, v = line.partition(":")
                    meta[current_key][k.strip()] = v.strip().strip('"')
    # Convert remaining None to empty dict (backwards compat)
    for k, v in meta.items():
        if v is None:
            meta[k] = {}
    return meta


def scalar(v):
    """Coerce a parsed value to a display string. Nested maps (e.g. a kind of
    {type: other, tag: backlog}) collapse to their 'type' or first value."""
    if isinstance(v, dict):
        return str(v.get("type") or next(iter(v.values()), ""))
    if isinstance(v, list):
        return ", ".join(str(x) for x in v)
    return v if v is not None else ""


def load_entries(domain_dir: Path) -> dict:
    """entryId -> {title, meta, body}."""
    entries = {}
    edir = domain_dir / "entries"
    if not edir.is_dir():
        return entries
    for md in sorted(edir.glob("*.md")):
        text = md.read_text(encoding="utf-8", errors="replace")
        fm, body = split_frontmatter(text)
        meta = parse_frontmatter(fm)
        eid = meta.get("id") or md.stem
        facets = meta.get("facets", {})
        facets = {k: scalar(v) for k, v in facets.items()} if isinstance(facets, dict) else {}
        entries[eid] = {
            "id": eid,
            "title": scalar(meta.get("title", eid)) or eid,
            "kind": scalar(meta.get("kind", "")),
            "maturity": scalar(meta.get("maturity", "")),
            "authority": scalar(meta.get("authority", "")),
            "currency": scalar(meta.get("currency", "")),
            "facets": facets,
            "body": body,
        }
    return entries


def load_work_items(domain_dir: Path) -> dict:
    """workId -> {id, title, kind, stage, partOf, body, ...}."""
    items = {}
    wdir = domain_dir / "work"
    if not wdir.is_dir():
        return items
    for md in sorted(wdir.glob("*.md")):
        text = md.read_text(encoding="utf-8", errors="replace")
        fm, body = split_frontmatter(text)
        meta = parse_frontmatter(fm)
        if meta.get("nodeType") != "work":
            continue
        wid = meta.get("id") or md.stem
        items[wid] = {
            "id": wid,
            "title": scalar(meta.get("title", wid)) or wid,
            "kind": scalar(meta.get("kind", "task")),
            "stage": scalar(meta.get("stage", "plan")),
            "assignee": scalar(meta.get("assignee", "")),
            "area": scalar(meta.get("area", "")),
            "partOf": scalar(meta.get("partOf", "")),
            "successCriteria": scalar(meta.get("successCriteria", "")),
            "dependsOn": parse_list(meta.get("dependsOn", [])),
            "blocks": parse_list(meta.get("blocks", [])),
            "body": body,
            "filePath": str(md),
        }
    return items


def parse_list(v):
    """Parse a YAML list field that may be a list or string."""
    if isinstance(v, list):
        return [str(x) for x in v]
    if isinstance(v, str) and v.strip():
        return [v.strip()]
    return []


def build_domain_dataset(domain: str, label: str, domain_dir: Path) -> dict:
    """Build nodes + edges + entry bodies for one domain."""
    entries = load_entries(domain_dir)
    digest_path = domain_dir / "_digest.json"
    sections = []
    if digest_path.is_file():
        try:
            sections = json.loads(digest_path.read_text(encoding="utf-8")).get("sections", [])
        except (json.JSONDecodeError, OSError):
            sections = []

    nodes = []
    edges = []
    bodies = {}
    seen_entry = set()

    dom_node = f"dom:{domain}"
    nodes.append({
        "id": dom_node,
        "label": label,
        "group": "domain",
        "value": 40,
        "meta": {"type": "Domain", "entries": len(entries)},
    })

    def walk(section_list, parent_id):
        for sec in section_list:
            sid = sec.get("sectionId", "")
            snode = f"sec:{sid}"
            nodes.append({
                "id": snode,
                "label": (sec.get("title", sid) or sid)[:48],
                "group": "section",
                "value": 20,
                "meta": {
                    "type": "Section",
                    "sectionId": sid,
                    "title": sec.get("title", ""),
                    "summary": sec.get("summary", ""),
                    "currency": sec.get("currency", ""),
                },
            })
            edges.append({"from": parent_id, "to": snode})
            for eid in sec.get("entryIds", []):
                enode = f"ent:{eid}"
                e = entries.get(eid, {"id": eid, "title": eid, "kind": "", "maturity": "",
                                      "authority": "", "currency": "", "facets": {}, "body": ""})
                if eid not in seen_entry:
                    seen_entry.add(eid)
                    nodes.append({
                        "id": enode,
                        "label": (e["title"] or eid)[:40],
                        "group": "entry",
                        "maturity": e.get("maturity", ""),
                        "value": 10,
                        "meta": {
                            "type": "Entry",
                            "id": eid,
                            "title": e["title"],
                            "kind": e.get("kind", ""),
                            "maturity": e.get("maturity", ""),
                            "authority": e.get("authority", ""),
                            "currency": e.get("currency", ""),
                            "facets": e.get("facets", {}),
                        },
                    })
                    bodies[enode] = e.get("body", "")
                edges.append({"from": snode, "to": enode})
            walk(sec.get("children", []), snode)

    walk(sections, dom_node)

    # Orphan entries not placed in any section
    for eid, e in entries.items():
        enode = f"ent:{eid}"
        if eid not in seen_entry:
            nodes.append({
                "id": enode,
                "label": (e["title"] or eid)[:40],
                "group": "entry",
                "maturity": e.get("maturity", ""),
                "value": 10,
                "meta": {"type": "Entry", "id": eid, "title": e["title"],
                         "kind": e.get("kind", ""), "maturity": e.get("maturity", ""),
                         "authority": e.get("authority", ""), "currency": e.get("currency", ""),
                         "facets": e.get("facets", {})},
            })
            bodies[enode] = e.get("body", "")
            edges.append({"from": dom_node, "to": enode})

    # Factory work items
    work_items = load_work_items(domain_dir)
    if work_items:
        factory_node = f"fac:{domain}"
        nodes.append({
            "id": factory_node,
            "label": "Factory",
            "group": "factory",
            "value": 25,
            "meta": {"type": "Factory", "workCount": len(work_items)},
        })
        edges.append({"from": dom_node, "to": factory_node})

        # Build work items, root items connect to factory, children via partOf
        work_ids_in_domain = set(work_items.keys())
        for wid, w in work_items.items():
            wnode = f"work:{wid}"
            nodes.append({
                "id": wnode,
                "label": (w["title"] or wid)[:40],
                "group": "work",
                "workKind": w.get("kind", "task"),
                "stage": w.get("stage", "plan"),
                "value": 12,
                "meta": {
                    "type": "Work",
                    "id": wid,
                    "title": w["title"],
                    "kind": w.get("kind", ""),
                    "stage": w.get("stage", ""),
                    "assignee": w.get("assignee", ""),
                    "area": w.get("area", ""),
                    "successCriteria": w.get("successCriteria", ""),
                    "filePath": str(domain_dir / "work" / f"{wid}.md"),
                    "dependsOn": w.get("dependsOn", []),
                },
            })
            bodies[wnode] = w.get("body", "")
            # Connect to parent or factory root
            parent_id = w.get("partOf", "")
            if parent_id and parent_id in work_ids_in_domain:
                edges.append({"from": f"work:{parent_id}", "to": wnode})
            else:
                edges.append({"from": factory_node, "to": wnode})

        # Add dependency edges (dependsOn: dashed lines)
        for wid, w in work_items.items():
            wnode = f"work:{wid}"
            for dep_id in w.get("dependsOn", []):
                if dep_id in work_ids_in_domain:
                    edges.append({"from": f"work:{dep_id}", "to": wnode, "type": "depends"})

    return {
        "domain": domain,
        "label": label,
        "nodes": nodes,
        "edges": edges,
        "bodies": bodies,
        "entryCount": len(entries),
        "sectionCount": len([n for n in nodes if n["group"] == "section"]),
        "workCount": len(work_items),
    }


def parse_domains_yaml(kb_root: Path) -> dict:
    """domain -> label, best-effort from domains.yaml; fallback to dir names."""
    labels = {}
    y = kb_root / "domains.yaml"
    if y.is_file():
        current = None
        for raw in y.read_text(encoding="utf-8").splitlines():
            indent = len(raw) - len(raw.lstrip(" "))
            line = raw.strip()
            if indent == 2 and line.endswith(":"):
                current = line[:-1]
            elif indent >= 4 and current and line.startswith("label:"):
                labels[current] = line.split(":", 1)[1].strip().strip('"')
    return labels


def collect(kb_root: Path) -> list:
    labels = parse_domains_yaml(kb_root)
    ddir = kb_root / "domains"
    datasets = []
    if not ddir.is_dir():
        return datasets
    for domain_dir in sorted(p for p in ddir.iterdir() if p.is_dir()):
        domain = domain_dir.name
        label = labels.get(domain, domain.capitalize())
        datasets.append(build_domain_dataset(domain, label, domain_dir))
    return datasets


HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>KB Knowledge Graph</title>
<script src="https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js"></script>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background:#0f1115; color:#e6e6e6; height:100vh; overflow:hidden;
         display:flex; flex-direction:column; }
  .btn { background:#1d2230; color:#c9d4e3; border:1px solid #2d3340; border-radius:6px;
         padding:5px 11px; font-size:12px; cursor:pointer; }
  .btn:hover { background:#252c3b; }
  #filters { display:flex; flex-wrap:wrap; align-items:center; gap:8px;
             padding:8px 16px; background:#12151c; border-bottom:1px solid #262b36; }
  #filters.collapsed { display:none; }
  #filters select { background:#0f1115; color:#cdd6e4; border:1px solid #2d3340;
                    border-radius:6px; padding:5px 8px; font-size:12px; }
  #filters select:disabled { opacity:0.4; }
  #panel.collapsed { display:none; }
  #bar { display:flex; align-items:center; gap:14px; padding:10px 16px;
         background:#161922; border-bottom:1px solid #262b36; }
  #bar h1 { font-size:15px; margin:0; font-weight:600; color:#9ecbff; }
  #bar select { background:#0f1115; color:#e6e6e6; border:1px solid #2d3340;
                border-radius:6px; padding:6px 10px; font-size:13px; }
  #bar .stat { font-size:12px; color:#8b94a3; }
  .legend { display:flex; gap:12px; margin-left:auto; font-size:11px; color:#8b94a3; }
  .legend span { display:inline-flex; align-items:center; gap:5px; }
  .dot { width:10px; height:10px; border-radius:50%; display:inline-block; }
  #main { display:flex; flex:1; min-height:0; }
  #graph { flex:1; min-width:0; background:#0f1115; }
  #panel { width:550px; border-left:1px solid #262b36; background:#12151c;
           overflow-y:auto; padding:18px 22px; }
  #panel .placeholder { color:#5c6573; font-size:13px; margin-top:40px; text-align:center; }
  #meta { font-size:12px; color:#8b94a3; margin-bottom:14px; line-height:1.7; }
  #meta .tag { display:inline-block; background:#1d2230; border:1px solid #2d3340;
               border-radius:4px; padding:1px 7px; margin:2px 4px 2px 0; color:#b9c2d0; }
  #md { line-height:1.6; font-size:14px; }
  #md h1 { font-size:20px; border-bottom:1px solid #262b36; padding-bottom:6px; }
  #md h2 { font-size:16px; color:#9ecbff; margin-top:22px; }
  #md h3 { font-size:14px; color:#c9d4e3; }
  #md code { background:#1d2230; padding:1px 5px; border-radius:4px; font-size:12px; }
  #md pre { background:#1a1e27; padding:12px; border-radius:8px; overflow-x:auto; }
  #md pre code { background:none; padding:0; }
  #md a { color:#9ecbff; }
  #md table { border-collapse:collapse; } #md td,#md th { border:1px solid #2d3340; padding:4px 8px; }
  /* Modal */
  #modal-overlay { display:none; position:fixed; top:0; left:0; right:0; bottom:0;
                   background:rgba(0,0,0,0.7); z-index:1000; align-items:center; justify-content:center; }
  #modal-overlay.active { display:flex; }
  #modal { background:#12151c; border:1px solid #2d3340; border-radius:12px;
           width:90%; max-width:700px; max-height:85vh; display:flex; flex-direction:column; }
  #modal-header { display:flex; align-items:center; justify-content:space-between;
                  padding:14px 18px; border-bottom:1px solid #262b36; }
  #modal-title { font-size:16px; font-weight:600; color:#9ecbff; margin:0; }
  #modal-close { background:none; border:none; color:#8b94a3; font-size:20px; cursor:pointer; padding:4px 8px; }
  #modal-close:hover { color:#e6e6e6; }
  #modal-body { flex:1; overflow-y:auto; padding:18px 22px; }
  #modal-body h1 { font-size:20px; border-bottom:1px solid #262b36; padding-bottom:6px; }
  #modal-body h2 { font-size:16px; color:#9ecbff; margin-top:22px; }
  #modal-body code { background:#1d2230; padding:1px 5px; border-radius:4px; font-size:12px; }
  #modal-body pre { background:#1a1e27; padding:12px; border-radius:8px; overflow-x:auto; }
  #modal-body pre code { background:none; padding:0; }
  #modal-body a { color:#9ecbff; }
</style>
</head>
<body>
<div id="bar">
  <h1>KB Graph</h1>
  <select id="kbSelect"></select>
  <span class="stat" id="counts"></span>
  <button id="filterToggle" class="btn">Filters</button>
  <button id="panelToggle" class="btn">Panel</button>
</div>
<div id="filters" class="collapsed">
  <select id="f-kind"></select>
  <select id="f-maturity"></select>
  <select id="f-authority"></select>
  <select id="f-currency"></select>
  <select id="f-subsystem"></select>
  <select id="f-layer"></select>
  <select id="f-lifecycle"></select>
  <button id="filterReset" class="btn">Reset</button>
</div>
<div id="main">
  <div id="graph"></div>
  <div id="panel">
    <div class="placeholder">Click a node to view its content.</div>
  </div>
</div>
<div id="modal-overlay">
  <div id="modal">
    <div id="modal-header">
      <h2 id="modal-title"></h2>
      <button id="modal-close">&times;</button>
    </div>
    <div id="modal-body"></div>
  </div>
</div>
<script>
const DATA = __DATA__;
const MATURITY_COLORS = { live:"#9ece6a", stub:"#e0af68", draft:"#bb9af7", deprecated:"#7a8290" };
// Completed work (shipped/live/archived) gets one muted color, whatever its kind.
const WORK_DONE_STAGES = ["shipped","live","archived"];
const WORK_DONE_COLOR = "#565f89";
const WORK_KIND_COLORS = { initiative:"#ff9e64", feature:"#bb9af7", task:"#73daca", issue:"#f7768e", spike:"#7dcfff", idea:"#e0af68" };
const FILTER_KEYS = ["kind","maturity","authority","currency","subsystem","layer","lifecycle"];
const FACET_KEYS = ["subsystem","layer","lifecycle"];
let network=null, nodesDS=null, edgesDS=null, currentDS=null;

function nodeColor(n){
  if(n.group==="domain") return "#9ecbff";
  if(n.group==="section") return "#7bdff2";
  if(n.group==="factory") return "#f7768e";
  if(n.group==="work") return WORK_DONE_STAGES.includes(n.stage) ? WORK_DONE_COLOR : (WORK_KIND_COLORS[n.workKind] || "#73daca");
  return MATURITY_COLORS[n.maturity] || "#7a8290";
}

function entryVal(meta, key){
  if(FACET_KEYS.includes(key)) return (meta.facets||{})[key] || "";
  return meta[key] || "";
}

function buildFilters(ds){
  const vals = {}; FILTER_KEYS.forEach(k=>vals[k]=new Set());
  ds.nodes.forEach(n=>{
    if(n.group!=="entry") return;
    FILTER_KEYS.forEach(k=>{ const v=entryVal(n.meta||{}, k); if(v) vals[k].add(v); });
  });
  FILTER_KEYS.forEach(k=>{
    const sel = document.getElementById("f-"+k);
    sel.innerHTML = "";
    const all = document.createElement("option"); all.value="__all__"; all.textContent=k+": all";
    sel.appendChild(all);
    [...vals[k]].sort().forEach(v=>{ const o=document.createElement("option"); o.value=v; o.textContent=k+": "+v; sel.appendChild(o); });
    sel.disabled = vals[k].size===0;
  });
}

function applyFilters(){
  if(!currentDS) return;
  const active = {};
  FILTER_KEYS.forEach(k=>{ const v=document.getElementById("f-"+k).value; if(v && v!=="__all__") active[k]=v; });
  const hasActive = Object.keys(active).length>0;
  const entryVisible = {}, sectionHasVisible = {};
  currentDS.nodes.forEach(n=>{
    if(n.group!=="entry") return;
    let ok=true;
    for(const k in active){ if(entryVal(n.meta||{}, k)!==active[k]){ ok=false; break; } }
    entryVisible[n.id]=ok;
  });
  currentDS.edges.forEach(e=>{ if(e.from.indexOf("sec:")===0 && entryVisible[e.to]) sectionHasVisible[e.from]=true; });
  const nodeUpdates = currentDS.nodes.map(n=>{
    let hidden=false;
    if(n.group==="entry") hidden=!entryVisible[n.id];
    else if(n.group==="section") hidden = hasActive && !sectionHasVisible[n.id];
    return {id:n.id, hidden};
  });
  nodesDS.update(nodeUpdates);
  const hiddenSet = new Set(nodeUpdates.filter(u=>u.hidden).map(u=>u.id));
  edgesDS.update(currentDS.edges.map((e,i)=>({id:"e"+i, hidden: hiddenSet.has(e.from)||hiddenSet.has(e.to)})));
  const shown = Object.values(entryVisible).filter(Boolean).length;
  document.getElementById("counts").textContent =
    (hasActive ? shown+" / "+currentDS.entryCount : currentDS.entryCount) + " entries · " + currentDS.sectionCount + " sections";
}

function render(domainKey){
  const ds = DATA.find(d=>d.domain===domainKey); currentDS = ds;
  const nodes = ds.nodes.map(n=>({
    id:n.id, label:n.label, value:n.value, group:n.group,
    color:{background:nodeColor(n), border:"#0f1115"},
    font:{color:"#cdd6e4", size: n.group==="domain"?18:(n.group==="section"?13:11)},
    shape: n.group==="domain"?"star":"dot",
    _meta:n.meta
  }));
  const edges = ds.edges.map((e,i)=>({
    id:"e"+i, from:e.from, to:e.to,
    color:{color: e.type==="depends" ? "#f7768e" : "#2d3340", opacity: e.type==="depends" ? 0.8 : 0.6},
    dashes: e.type==="depends",
    arrows: e.type==="depends" ? {to:{enabled:true,scaleFactor:0.5}} : undefined,
  }));
  nodesDS = new vis.DataSet(nodes); edgesDS = new vis.DataSet(edges);
  network = new vis.Network(document.getElementById("graph"), {nodes:nodesDS, edges:edgesDS}, {
    physics:{ stabilization:true, barnesHut:{gravitationalConstant:-8000, springLength:120} },
    interaction:{ hover:true, tooltipDelay:120 },
    edges:{ smooth:{type:"continuous"} },
    nodes:{ scaling:{min:8,max:40} }
  });
  let focusedNode = null;
  
  function getConnected(nodeId) {
    const connected = new Set([nodeId]);
    ds.edges.forEach(e => {
      if (e.from === nodeId) connected.add(e.to);
      if (e.to === nodeId) connected.add(e.from);
    });
    return connected;
  }
  
  function focusNode(nodeId) {
    if (focusedNode === nodeId) return;
    focusedNode = nodeId;
    const connected = getConnected(nodeId);
    nodesDS.update(ds.nodes.map(n => ({
      id: n.id,
      hidden: !connected.has(n.id),
      color: { background: nodeColor(n), border: connected.has(n.id) ? "#fff" : "#0f1115" }
    })));
    edgesDS.update(ds.edges.map((e, i) => ({
      id: "e" + i,
      hidden: !connected.has(e.from) || !connected.has(e.to)
    })));
  }
  
  function clearFocus() {
    if (!focusedNode) return;
    focusedNode = null;
    nodesDS.update(ds.nodes.map(n => ({
      id: n.id,
      hidden: false,
      color: { background: nodeColor(n), border: "#0f1115" }
    })));
    edgesDS.update(ds.edges.map((e, i) => ({ id: "e" + i, hidden: false })));
    applyFilters();
  }
  
  network.on("click", params => {
    if (!params.nodes.length) {
      clearFocus();
      return;
    }
    const id = params.nodes[0];
    const node = nodes.find(n => n.id === id);
    showPanel(node, ds.bodies[id]);
    focusNode(id);
  });
  
  network.on("doubleClick", () => clearFocus());
  buildFilters(ds);
  applyFilters();
}

function showModal(node, body) {
  const m = node.meta || {};
  const overlay = document.getElementById("modal-overlay");
  const title = document.getElementById("modal-title");
  const modalBody = document.getElementById("modal-body");
  
  title.textContent = m.title || node.label || "";
  
  let md = body || "_(no content)_";
  if (m.successCriteria) {
    md += "\\n\\n**Done when:** " + m.successCriteria;
  }
  
  modalBody.innerHTML = marked.parse(md);
  overlay.classList.add("active");
}

function hideModal() {
  document.getElementById("modal-overlay").classList.remove("active");
}

function showPanel(node, body){
  const m = node._meta || {};
  const panel = document.getElementById("panel");
  let tags = "";
  if(m.type==="Work"){
    // Check if ready (no incomplete dependencies)
    const deps = m.dependsOn || [];
    const incompleteDeps = deps.filter(depId => {
      const depNode = currentDS.nodes.find(n => n.id === "work:" + depId);
      const depStage = depNode ? (depNode.meta || {}).stage : "";
      return depNode && depStage !== "shipped" && depStage !== "live" && depStage !== "archived";
    });
    const isReady = incompleteDeps.length === 0;
    if (isReady && m.stage === "plan") {
      tags += `<span class="tag" style="background:#2d4a3e;border-color:#3d6a4e;color:#9ece6a">✓ ready to start</span>`;
    } else if (!isReady) {
      tags += `<span class="tag" style="background:#4a2d2d;border-color:#6a3d3d;color:#f7768e">⛔ blocked</span>`;
    }
    for(const k of ["kind","stage","assignee","area"]){
      if(m[k]) tags += `<span class="tag">${k}: ${m[k]}</span>`;
    }
  } else {
    for(const k of ["kind","maturity","authority","currency"]){
      if(m[k]) tags += `<span class="tag">${k}: ${m[k]}</span>`;
    }
    if(m.facets){ for(const [k,v] of Object.entries(m.facets)){ tags += `<span class="tag">${k}: ${v}</span>`; } }
  }
  let md = "";
  if(m.type==="Entry"){ md = body || "_(no body)_"; }
  else if(m.type==="Section"){ md = "## "+(m.title||"")+"\\n\\n"+(m.summary||"_(section)_"); }
  else if(m.type==="Work"){
    const criteria = m.successCriteria ? "\\n\\n**Done when:** "+m.successCriteria : "";
    md = (body || "_(no plan yet)_") + criteria;
    
    // Find children (items with partOf pointing to this)
    const nodeId = node.id;
    const workId = m.id;
    // Children are connected via non-dependency edges FROM this node
    const childIds = new Set(currentDS.edges
      .filter(e => e.from === nodeId && e.type !== "depends")
      .map(e => e.to));
    const children = currentDS.nodes.filter(n => childIds.has(n.id) && n.group === "work");
    
    if (children.length > 0) {
      // Categorize children into Completed, Unlocked, Blocked
      const categorized = children.map(child => {
        const childMeta = child.meta || {};
        const stage = childMeta.stage || "";
        const deps = childMeta.dependsOn || [];
        const isCompleted = ["shipped", "live", "archived"].includes(stage);
        const incompleteDeps = deps.filter(depId => {
          const depNode = currentDS.nodes.find(n => n.id === "work:" + depId);
          const depStage = depNode ? (depNode.meta || {}).stage : "";
          return depNode && depStage !== "shipped" && depStage !== "live" && depStage !== "archived";
        });
        const isUnlocked = !isCompleted && incompleteDeps.length === 0;
        const isBlocked = !isCompleted && incompleteDeps.length > 0;
        return { ...child, isCompleted, isUnlocked, isBlocked, depCount: incompleteDeps.length };
      });
      
      const completed = categorized.filter(c => c.isCompleted);
      const unlocked = categorized.filter(c => c.isUnlocked);
      const blocked = categorized.filter(c => c.isBlocked).sort((a, b) => a.depCount - b.depCount);
      
      md += "\\n\\n---\\n\\n";
      
      const renderGroup = (title, items, color, icon) => {
        if (items.length === 0) return "";
        let html = `<div style="margin-bottom:16px;"><div style="color:${color};font-weight:600;margin-bottom:8px;font-size:13px;">${icon} ${title}</div>`;
        html += `<div class="child-links">`;
        for (const child of items) {
          const filePath = (child.meta || {}).filePath || "";
          html += `<div class="child-link" data-node-id="${child.id}" data-file-path="${filePath}" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:6px 10px;margin:4px 0;background:#1d2230;border-radius:6px;border-left:3px solid ${color}">`;
          html += `<span style="flex:1;">${child.label}</span>`;
          if (filePath) {
            html += `<span class="open-btn" data-file-path="${filePath}" style="padding:2px 8px;font-size:11px;background:#363d52;border-radius:4px;color:#7aa2f7;margin-left:8px;">Open</span>`;
          }
          html += `</div>`;
        }
        html += `</div></div>`;
        return html;
      };
      
      md += renderGroup("Completed", completed, "#9ece6a", "✓");
      md += renderGroup("Unlocked", unlocked, "#7dcfff", "▶");
      md += renderGroup("Blocked", blocked, "#f7768e", "⛔");
    }
  }
  else if(m.type==="Factory"){ md = "# Factory\\n\\nLive work items: "+(m.workCount||0); }
  else { md = "# "+node.label+"\\n\\nDomain root — "+(m.entries||0)+" entries."; }
  
  panel.innerHTML =
    `<div id="meta"><strong>${m.type||""}</strong><br>${tags}</div>` +
    `<div id="md">${marked.parse(md)}</div>`;
  
  // Add click handlers for child links
  panel.querySelectorAll(".child-link").forEach(el => {
    el.addEventListener("click", (e) => {
      // Don't navigate if clicking the open button
      if (e.target.classList.contains("open-btn")) return;
      const targetId = el.getAttribute("data-node-id");
      if (targetId && network) {
        network.selectNodes([targetId]);
        focusNode(targetId);
        const targetNode = currentDS.nodes.find(n => n.id === targetId);
        if (targetNode) showPanel(targetNode, currentDS.bodies[targetId]);
      }
    });
    el.addEventListener("mouseenter", () => { el.style.background = "#252c3b"; });
    el.addEventListener("mouseleave", () => { el.style.background = "#1d2230"; });
  });
  
  // Add click handlers for open buttons (show modal)
  panel.querySelectorAll(".open-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const parentEl = btn.closest(".child-link");
      const nodeId = parentEl ? parentEl.getAttribute("data-node-id") : null;
      if (nodeId) {
        const targetNode = currentDS.nodes.find(n => n.id === nodeId);
        const body = currentDS.bodies[nodeId] || "";
        if (targetNode) {
          showModal(targetNode, body);
        }
      }
    });
    btn.addEventListener("mouseenter", () => { btn.style.background = "#4a5577"; });
    btn.addEventListener("mouseleave", () => { btn.style.background = "#363d52"; });
  });
  
  panel.scrollTop = 0;
}

const sel = document.getElementById("kbSelect");
DATA.forEach(d=>{ const o=document.createElement("option"); o.value=d.domain; o.textContent=d.label; sel.appendChild(o); });
sel.addEventListener("change", ()=>render(sel.value));

FILTER_KEYS.forEach(k=>document.getElementById("f-"+k).addEventListener("change", applyFilters));
document.getElementById("filterReset").addEventListener("click", ()=>{
  FILTER_KEYS.forEach(k=>{ document.getElementById("f-"+k).value="__all__"; });
  applyFilters();
});

const panel = document.getElementById("panel");
const panelToggle = document.getElementById("panelToggle");
panelToggle.addEventListener("click", ()=>{
  panel.classList.toggle("collapsed");
  if(network){ network.redraw(); network.fit(); }
});

const filters = document.getElementById("filters");
const filterToggle = document.getElementById("filterToggle");
filterToggle.addEventListener("click", ()=>{
  filters.classList.toggle("collapsed");
});

// Modal event handlers
document.getElementById("modal-close").addEventListener("click", hideModal);
document.getElementById("modal-overlay").addEventListener("click", (e) => {
  if (e.target.id === "modal-overlay") hideModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideModal();
});

if(DATA.length) render(DATA[0].domain);
</script>
</body>
</html>
"""


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--kb-root", default=str(DEFAULT_KB_ROOT))
    ap.add_argument("--out", default=str(Path.home() / ".cache" / "kb-graph" / "kb-graph.html"))
    ap.add_argument("--no-open", action="store_true")
    args = ap.parse_args(argv)

    kb_root = Path(args.kb_root).expanduser()
    if not (kb_root / "domains").is_dir():
        print(f"error: no domains/ under {kb_root}", file=sys.stderr)
        return 2

    datasets = collect(kb_root)
    if not datasets:
        print(f"error: no domains found under {kb_root}", file=sys.stderr)
        return 2

    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    doc = HTML_TEMPLATE.replace("__DATA__", json.dumps(datasets, ensure_ascii=False))
    out.write_text(doc, encoding="utf-8")

    total_e = sum(d["entryCount"] for d in datasets)
    total_w = sum(d.get("workCount", 0) for d in datasets)
    print(f"Built graph: {len(datasets)} knowledge base(s), {total_e} entries, {total_w} work items")
    for d in datasets:
        wc = d.get("workCount", 0)
        work_str = f", {wc} work items" if wc else ""
        print(f"  - {d['label']} ({d['domain']}): {d['entryCount']} entries, {d['sectionCount']} sections{work_str}")
    print(f"Wrote {out}")

    if not args.no_open:
        if sys.platform == "darwin":
            subprocess.run(["open", str(out)], check=False)
        else:
            webbrowser.open(out.as_uri())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
