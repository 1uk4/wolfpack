export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wolfpack Dashboard</title>
<script src="https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js"><\/script>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; margin: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
       background: #0f1115; color: #e6e6e6; height: 100vh; overflow: hidden;
       display: flex; flex-direction: column; }

/* Top bar */
#bar { display: flex; align-items: center; gap: 12px; padding: 10px 16px;
       background: #161922; border-bottom: 1px solid #262b36; flex-shrink: 0; }
#bar h1 { font-size: 15px; font-weight: 600; color: #9ecbff; }
#bar select { background: #0f1115; color: #e6e6e6; border: 1px solid #2d3340;
              border-radius: 6px; padding: 6px 10px; font-size: 13px; }
.btn { background: #1d2230; color: #c9d4e3; border: 1px solid #2d3340;
       border-radius: 6px; padding: 5px 11px; font-size: 12px; cursor: pointer; }
.btn:hover { background: #252c3b; }
.stat { font-size: 12px; color: #8b94a3; margin-left: auto; }
.legend { display: flex; gap: 10px; font-size: 11px; color: #8b94a3; }
.legend span { display: inline-flex; align-items: center; gap: 4px; }
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }

/* Filters */
#filters { display: none; flex-wrap: wrap; gap: 8px; padding: 8px 16px;
           background: #12151c; border-bottom: 1px solid #262b36; }
#filters.open { display: flex; }
#filters select { background: #0f1115; color: #cdd6e4; border: 1px solid #2d3340;
                  border-radius: 6px; padding: 5px 8px; font-size: 12px; }

/* Main layout */
#main { display: flex; flex: 1; min-height: 0; }
#tree { width: 280px; background: #12151c; border-right: 1px solid #262b36;
        overflow-y: auto; padding: 12px; font-size: 12px; flex-shrink: 0; display: none; }
#tree.open { display: block; }
#tree .tree-domain { font-weight: 600; color: #9ecbff; margin-bottom: 8px; font-size: 13px; }
#tree .tree-section { cursor: pointer; padding: 4px 6px; border-radius: 4px;
                      border-left: 3px solid #7bdff2; margin: 2px 0; }
#tree .tree-section:hover { background: #1d2230; }
#tree .tree-section .arrow { display: inline-block; width: 12px; font-size: 10px;
                              color: #7bdff2; transition: transform 0.15s; }
#tree .tree-section .arrow.open { transform: rotate(90deg); }
#tree .tree-section .label { color: #cdd6e4; }
#tree .tree-section .count { color: #8b94a3; font-size: 11px; margin-left: 4px; }
#tree .tree-children { margin-left: 12px; display: none; }
#tree .tree-children.open { display: block; }
#tree .tree-entry { padding: 2px 6px; color: #8b94a3; cursor: pointer; border-radius: 3px; }
#tree .tree-entry:hover { background: #1d2230; color: #cdd6e4; }
#graph { flex: 1; min-width: 0; background: #0f1115; }

/* Side panel */
#panel { width: 500px; border-left: 1px solid #262b36; background: #12151c;
         overflow-y: auto; padding: 18px 22px; display: none; }
#panel.open { display: block; }
#panel .placeholder { color: #5c6573; font-size: 13px; margin-top: 40px; text-align: center; }
#panel-title { font-size: 16px; font-weight: 600; color: #9ecbff; margin-bottom: 8px; }
#panel-meta { font-size: 12px; color: #8b94a3; margin-bottom: 14px; line-height: 1.7; }
#panel-meta .tag { display: inline-block; background: #1d2230; border: 1px solid #2d3340;
                   border-radius: 4px; padding: 1px 7px; margin: 2px 4px 2px 0; color: #b9c2d0; }
#panel-body { line-height: 1.6; font-size: 14px; }
#panel-body h1 { font-size: 20px; border-bottom: 1px solid #262b36; padding-bottom: 6px; }
#panel-body h2 { font-size: 16px; color: #9ecbff; margin-top: 22px; }
#panel-body h3 { font-size: 14px; color: #c9d4e3; }
#panel-body code { background: #1d2230; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
#panel-body pre { background: #1a1e27; padding: 12px; border-radius: 8px; overflow-x: auto; }
#panel-body pre code { background: none; padding: 0; }
#panel-body a { color: #9ecbff; }
#panel-body table { border-collapse: collapse; width: 100%; margin: 8px 0; }
#panel-body td, #panel-body th { border: 1px solid #2d3340; padding: 4px 8px; font-size: 12px; }

/* Modal */
#modal-overlay { display: none; position: fixed; inset: 0;
                 background: rgba(0,0,0,0.7); z-index: 1000; align-items: center; justify-content: center; }
#modal-overlay.open { display: flex; }
#modal { background: #12151c; border: 1px solid #2d3340; border-radius: 12px;
         width: 90%; max-width: 700px; max-height: 85vh; display: flex; flex-direction: column; }
#modal-header { display: flex; align-items: center; justify-content: space-between;
                padding: 14px 18px; border-bottom: 1px solid #262b36; }
#modal-title { font-size: 16px; font-weight: 600; color: #9ecbff; }
#modal-close { background: none; border: none; color: #8b94a3; font-size: 20px; cursor: pointer; }
#modal-close:hover { color: #e6e6e6; }
#modal-body { flex: 1; overflow-y: auto; padding: 18px 22px; line-height: 1.6; font-size: 14px; }
#modal-body h1 { font-size: 20px; border-bottom: 1px solid #262b36; padding-bottom: 6px; }
#modal-body h2 { font-size: 16px; color: #9ecbff; margin-top: 22px; }
#modal-body code { background: #1d2230; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
#modal-body pre { background: #1a1e27; padding: 12px; border-radius: 8px; overflow-x: auto; }
#modal-body pre code { background: none; padding: 0; }
#modal-body a { color: #9ecbff; }
</style>
</head>
<body>

<div id="bar">
  <h1>Wolfpack</h1>
  <select id="domainSelect"></select>
  <button class="btn" id="treeToggle">Tree</button>
  <button class="btn" id="filterToggle">Filters</button>
  <button class="btn" id="panelToggle">Panel</button>
  <button class="btn" id="fitBtn">Fit</button>
  <span class="stat" id="stats"></span>
  <div class="legend">
    <span><span class="dot" style="background:#9ecbff"></span>Domain</span>
    <span><span class="dot" style="background:#7bdff2"></span>Section</span>
    <span><span class="dot" style="background:#9ece6a"></span>Entry</span>
    <span><span class="dot" style="background:#f7768e"></span>Factory</span>
    <span><span class="dot" style="background:#73daca"></span>Work</span>
  </div>
</div>

<div id="filters">
  <select id="f-kind"><option value="">Kind</option></select>
  <select id="f-maturity"><option value="">Maturity</option></select>
  <select id="f-authority"><option value="">Authority</option></select>
  <select id="f-currency"><option value="">Currency</option></select>
  <select id="f-subsystem"><option value="">Subsystem</option></select>
  <button class="btn" id="filterReset">Reset</button>
</div>

<div id="main">
  <div id="tree"></div>
  <div id="graph"></div>
  <div id="panel">
    <div class="placeholder">Click a node to view its content.</div>
    <div id="panel-title" style="display:none"></div>
    <div id="panel-meta" style="display:none"></div>
    <div id="panel-body" style="display:none"></div>
  </div>
</div>

<div id="modal-overlay">
  <div id="modal">
    <div id="modal-header">
      <span id="modal-title"></span>
      <button id="modal-close">&times;</button>
    </div>
    <div id="modal-body"></div>
  </div>
</div>

<script>
const MATURITY_COLORS = { live: "#9ece6a", stub: "#e0af68", draft: "#bb9af7", deprecated: "#7a8290" };
const WORK_DONE_STAGES = ["shipped", "live", "archived"];
const WORK_DONE_COLOR = "#565f89";
const WORK_KIND_COLORS = { initiative: "#ff9e64", feature: "#bb9af7", task: "#73daca", issue: "#f7768e", spike: "#7dcfff", idea: "#e0af68" };
const FILTER_KEYS = ["kind", "maturity", "authority", "currency", "subsystem"];
const FACET_KEYS = ["subsystem"];

let DATA = [];
let network = null;
let nodesDS = null;
let edgesDS = null;
let currentDS = null;

function nodeColor(n) {
  if (n.group === "domain") return "#9ecbff";
  if (n.group === "section") return "#7bdff2";
  if (n.group === "factory") return "#f7768e";
  if (n.group === "work") return WORK_DONE_STAGES.includes(n.stage) ? WORK_DONE_COLOR : (WORK_KIND_COLORS[n.workKind] || "#73daca");
  return MATURITY_COLORS[n.maturity] || "#9ece6a";
}

function nodeSize(n) {
  if (n.group === "domain") return 35;
  if (n.group === "section") return 18;
  if (n.group === "factory") return 22;
  if (n.group === "work") return 8;
  return 10;
}

function entryVal(meta, key) {
  if (FACET_KEYS.includes(key)) return (meta.facets || {})[key] || "";
  return meta[key] || "";
}

function buildFilters(ds) {
  var vals = {};
  FILTER_KEYS.forEach(function(k) { vals[k] = new Set(); });
  ds.nodes.forEach(function(n) {
    if (n.group !== "entry") return;
    FILTER_KEYS.forEach(function(k) {
      var v = entryVal(n.meta || {}, k);
      if (v) vals[k].add(v);
    });
  });
  FILTER_KEYS.forEach(function(k) {
    var sel = document.getElementById("f-" + k);
    var prev = sel.value;
    sel.innerHTML = '<option value="">All ' + k + '</option>';
    Array.from(vals[k]).sort().forEach(function(v) {
      sel.innerHTML += '<option value="' + v + '">' + v + '</option>';
    });
    sel.value = prev;
  });
}

function applyFilters() {
  if (!currentDS || !nodesDS) return;
  var active = {};
  FILTER_KEYS.forEach(function(k) {
    var v = document.getElementById("f-" + k).value;
    if (v) active[k] = v;
  });
  if (Object.keys(active).length === 0) {
    nodesDS.clear();
    nodesDS.add(currentDS.nodes.map(makeVisNode));
    edgesDS.clear();
    edgesDS.add(currentDS.edges.map(makeVisEdge));
    return;
  }
  var keep = new Set();
  currentDS.nodes.forEach(function(n) {
    if (n.group !== "entry") { keep.add(n.id); return; }
    var pass = true;
    Object.keys(active).forEach(function(k) {
      if (entryVal(n.meta || {}, k) !== active[k]) pass = false;
    });
    if (pass) keep.add(n.id);
  });
  nodesDS.clear();
  nodesDS.add(currentDS.nodes.filter(function(n) { return keep.has(n.id); }).map(makeVisNode));
  edgesDS.clear();
  edgesDS.add(currentDS.edges.filter(function(e) { return keep.has(e.from) && keep.has(e.to); }).map(makeVisEdge));
}

function makeVisNode(n) {
  return {
    id: n.id,
    label: (n.label || "").substring(0, 45),
    title: n.meta ? n.meta.title || n.label : n.label,
    color: { background: nodeColor(n), border: nodeColor(n) },
    size: nodeSize(n),
    font: { color: n.group === "domain" ? "#fff" : "#cdd6e4", size: n.group === "domain" ? 14 : n.group === "section" ? 11 : 9 },
    shape: n.group === "domain" ? "star" : "dot",
    _raw: n
  };
}

function makeVisEdge(e) {
  return {
    from: e.from,
    to: e.to,
    color: { color: e.type === "depends" ? "#f7768e" : "#1d2230" },
    dashes: e.type === "depends",
    arrows: e.type === "depends" ? { to: { enabled: true, scaleFactor: 0.5 } } : undefined,
    width: e.type === "depends" ? 1.5 : 0.8
  };
}

function render(domain) {
  var ds = DATA.find(function(d) { return d.domain === domain; });
  if (!ds) return;
  currentDS = ds;
  buildFilters(ds);

  nodesDS = new vis.DataSet(ds.nodes.map(makeVisNode));
  edgesDS = new vis.DataSet(ds.edges.map(makeVisEdge));

  var container = document.getElementById("graph");
  network = new vis.Network(container, { nodes: nodesDS, edges: edgesDS }, {
    physics: {
      solver: "forceAtlas2Based",
      forceAtlas2Based: { gravitationalConstant: -40, centralGravity: 0.005, springLength: 80 },
      stabilization: { iterations: 150 }
    },
    interaction: { hover: true, tooltipDelay: 200 }
  });

  network.on("click", function(params) {
    if (params.nodes.length === 0) return;
    var node = nodesDS.get(params.nodes[0]);
    if (node && node._raw) showNode(node._raw);
  });

  network.on("doubleClick", function(params) {
    if (params.nodes.length === 0) return;
    var node = nodesDS.get(params.nodes[0]);
    if (node && node._raw) showModal(node._raw);
  });

  document.getElementById("stats").textContent =
    ds.sectionCount + " sections, " + ds.entryCount + " entries" +
    (ds.workCount > 0 ? ", " + ds.workCount + " work items" : "");

  buildTree(ds);
}

function buildTree(ds) {
  var treeEl = document.getElementById("tree");
  // Build section lookup from nodes and edges
  var sectionNodes = {};
  ds.nodes.forEach(function(n) {
    if (n.group === "section" || n.group === "domain") sectionNodes[n.id] = n;
  });

  // Build parent->children map from edges
  var children = {};
  var entryParent = {};
  ds.edges.forEach(function(e) {
    if (!e.type) { // not dependency edges
      if (!children[e.from]) children[e.from] = [];
      children[e.from].push(e.to);
      // Track entry->section mapping
      var toNode = ds.nodes.find(function(n) { return n.id === e.to; });
      if (toNode && toNode.group === "entry") entryParent[e.to] = e.from;
    }
  });

  function renderSection(nodeId, depth) {
    var node = sectionNodes[nodeId];
    if (!node) return "";
    var kids = (children[nodeId] || []);
    var sectionKids = kids.filter(function(id) { return sectionNodes[id] && sectionNodes[id].group === "section"; });
    var entryKids = kids.filter(function(id) {
      var n = ds.nodes.find(function(x) { return x.id === id; });
      return n && n.group === "entry";
    });
    var totalEntries = entryKids.length;

    var html = '<div class="tree-section" data-node="' + nodeId + '">';
    if (sectionKids.length > 0 || entryKids.length > 0) {
      html += '<span class="arrow">&#9654;</span>';
    } else {
      html += '<span style="width:12px;display:inline-block"></span>';
    }
    html += '<span class="label">' + (node.label || node.id) + '</span>';
    if (totalEntries > 0) html += '<span class="count">' + totalEntries + '</span>';
    html += '</div>';

    if (sectionKids.length > 0 || entryKids.length > 0) {
      html += '<div class="tree-children" data-parent="' + nodeId + '">';
      sectionKids.forEach(function(sid) { html += renderSection(sid, depth + 1); });
      entryKids.forEach(function(eid) {
        var eNode = ds.nodes.find(function(n) { return n.id === eid; });
        if (eNode) {
          html += '<div class="tree-entry" data-node="' + eid + '">' + (eNode.label || eid) + '</div>';
        }
      });
      html += '</div>';
    }
    return html;
  }

  // Find the domain root
  var domainNodeId = "dom:" + ds.domain;
  var rootKids = (children[domainNodeId] || []).filter(function(id) {
    return sectionNodes[id] && sectionNodes[id].group === "section";
  });

  var html = '<div class="tree-domain">' + ds.label + '</div>';
  rootKids.forEach(function(sid) { html += renderSection(sid, 0); });

  // Orphan entries (connected to domain, not a section)
  var orphanEntries = (children[domainNodeId] || []).filter(function(id) {
    var n = ds.nodes.find(function(x) { return x.id === id; });
    return n && n.group === "entry";
  });
  if (orphanEntries.length > 0) {
    html += '<div class="tree-section" style="border-left-color:#e0af68;"><span style="width:12px;display:inline-block"></span><span class="label" style="color:#e0af68;">Unplaced (' + orphanEntries.length + ')</span></div>';
  }

  treeEl.innerHTML = html;
  treeEl.classList.add("open");

  // Click handlers
  treeEl.querySelectorAll(".tree-section").forEach(function(el) {
    el.addEventListener("click", function(e) {
      e.stopPropagation();
      var nodeId = el.getAttribute("data-node");
      // Toggle children
      var childDiv = el.nextElementSibling;
      if (childDiv && childDiv.classList.contains("tree-children")) {
        childDiv.classList.toggle("open");
        var arrow = el.querySelector(".arrow");
        if (arrow) arrow.classList.toggle("open");
      }
      // Focus in graph
      if (network && nodeId) {
        network.selectNodes([nodeId]);
        network.focus(nodeId, { scale: 1.2, animation: true });
        var raw = ds.nodes.find(function(n) { return n.id === nodeId; });
        if (raw) showNode(raw);
      }
    });
  });

  treeEl.querySelectorAll(".tree-entry").forEach(function(el) {
    el.addEventListener("click", function(e) {
      e.stopPropagation();
      var nodeId = el.getAttribute("data-node");
      if (network && nodeId) {
        network.selectNodes([nodeId]);
        network.focus(nodeId, { scale: 1.5, animation: true });
        var raw = ds.nodes.find(function(n) { return n.id === nodeId; });
        if (raw) showNode(raw);
      }
    });
  });
}

function showNode(raw) {
  var panel = document.getElementById("panel");
  var placeholder = panel.querySelector(".placeholder");
  var title = document.getElementById("panel-title");
  var meta = document.getElementById("panel-meta");
  var body = document.getElementById("panel-body");

  placeholder.style.display = "none";
  title.style.display = "block";
  meta.style.display = "block";
  body.style.display = "block";
  panel.classList.add("open");

  var m = raw.meta || {};
  title.textContent = m.title || raw.label || raw.id;

  var tags = [];
  if (m.type) tags.push(m.type);
  if (m.kind) tags.push(m.kind);
  if (m.maturity) tags.push(m.maturity);
  if (m.stage) tags.push(m.stage);
  if (m.currency) tags.push(m.currency);
  meta.innerHTML = tags.map(function(t) { return '<span class="tag">' + t + '</span>'; }).join(" ");

  if (m.summary) {
    meta.innerHTML += '<br>' + m.summary;
  }

  var content = currentDS.bodies ? (currentDS.bodies["ent:" + raw.id] || currentDS.bodies["work:" + raw.id] || currentDS.bodies[raw.id] || "") : "";
  body.innerHTML = content ? marked.parse(content) : "<em>No content</em>";
}

function showModal(raw) {
  var m = raw.meta || {};
  document.getElementById("modal-title").textContent = m.title || raw.label || raw.id;
  var content = currentDS.bodies ? (currentDS.bodies["ent:" + raw.id] || currentDS.bodies["work:" + raw.id] || currentDS.bodies[raw.id] || "") : "";
  document.getElementById("modal-body").innerHTML = content ? marked.parse(content) : "<em>No content</em>";
  document.getElementById("modal-overlay").classList.add("open");
}

function hideModal() {
  document.getElementById("modal-overlay").classList.remove("open");
}

// Init
var sel = document.getElementById("domainSelect");
sel.addEventListener("change", function() { render(sel.value); });

document.getElementById("treeToggle").addEventListener("click", function() {
  document.getElementById("tree").classList.toggle("open");
  if (network) { network.redraw(); network.fit(); }
});
document.getElementById("filterToggle").addEventListener("click", function() {
  document.getElementById("filters").classList.toggle("open");
});
document.getElementById("panelToggle").addEventListener("click", function() {
  document.getElementById("panel").classList.toggle("open");
  if (network) { network.redraw(); network.fit(); }
});
document.getElementById("fitBtn").addEventListener("click", function() {
  if (network) network.fit({ animation: true });
});
document.getElementById("filterReset").addEventListener("click", function() {
  FILTER_KEYS.forEach(function(k) { document.getElementById("f-" + k).value = ""; });
  applyFilters();
});
FILTER_KEYS.forEach(function(k) {
  document.getElementById("f-" + k).addEventListener("change", applyFilters);
});
document.getElementById("modal-close").addEventListener("click", hideModal);
document.getElementById("modal-overlay").addEventListener("click", function(e) {
  if (e.target.id === "modal-overlay") hideModal();
});
document.addEventListener("keydown", function(e) { if (e.key === "Escape") hideModal(); });

// Fetch data
fetch("/dashboard/api/kb-graph")
  .then(function(r) { return r.json(); })
  .then(function(data) {
    DATA = data;
    sel.innerHTML = "";
    DATA.forEach(function(d) {
      var o = document.createElement("option");
      o.value = d.domain;
      o.textContent = d.label + " (" + d.entryCount + " entries)";
      sel.appendChild(o);
    });
    if (DATA.length) render(DATA[0].domain);
  })
  .catch(function(e) { console.error("Failed to load:", e); });
<\/script>
</body>
</html>`;
