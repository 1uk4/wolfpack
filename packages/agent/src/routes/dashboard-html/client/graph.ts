export const GRAPH_JS = `function nodeColor(n) {
  if (n.group === "domain") return "#9ecbff";
  if (n.group === "section") return "#7bdff2";
  if (n.group === "factory") return "#f7768e";
  if (n.group === "work") {
    if (n.stage === "archived") return WORK_ARCHIVED_COLOR;
    if (WORK_DONE_STAGES.includes(n.stage)) return WORK_DONE_COLOR;
    return WORK_KIND_COLORS[n.workKind] || "#73daca";
  }
  return MATURITY_COLORS[n.maturity] || "#9ece6a";
}

function nodeSize(n) {
  if (n.group === "domain") return 35;
  if (n.group === "section") return 18;
  if (n.group === "factory") return 22;
  if (n.group === "work") return 8;
  return 10;
}

function buildNodeIndex(nodes) {
  var idx = {};
  nodes.forEach(function(n) { idx[n.id] = n; });
  return idx;
}

// Every node has the same mass. In forceAtlas2Based, mass scales repulsion,
// so mixed masses (0.4 to 50) flung light nodes around heavy ones and kept
// the graph moving. Layout comes from edge lengths and the anchor's springs.
function nodeMass(n) {
  return 1;
}

function makeVisNode(n) {
  if (n.group === "anchor") {
    // Invisible central weight: no color, no border, no label; still exerts
    // physics so attached domains settle around a shared center. Not clickable.
    return {
      id: n.id,
      label: "",
      shape: "dot",
      size: 0.1,
      mass: nodeMass(n),
      color: { background: "rgba(0,0,0,0)", border: "rgba(0,0,0,0)" },
      font: { color: "rgba(0,0,0,0)", size: 0 },
      chosen: false,
      fixed: { x: true, y: true },
      x: 0, y: 0,
      _raw: n,
    };
  }
  // Join tasks: tasks with 2+ incoming dep edges from sibling tasks under
  // the same feature. Rendered as a diamond with a ⊲N badge so the
  // fork-join (fan-in) sync point is visible at a glance.
  var joinInputs = n._joinInputs || 0;
  var isJoin = joinInputs >= 2;
  var baseLabel = (n.label || "").substring(0, 45);
  var label = isJoin ? ("⊲" + joinInputs + "  " + baseLabel) : baseLabel;
  var shape = n.group === "domain" ? "star" : (isJoin ? "diamond" : "dot");
  var size = nodeSize(n);
  if (isJoin) size = Math.max(size + 4, 12);
  return {
    id: n.id,
    label: label,
    title: n.meta ? n.meta.title || n.label : n.label,
    color: { background: nodeColor(n), border: nodeColor(n) },
    size: size,
    mass: nodeMass(n),
    font: { color: n.group === "domain" ? "#fff" : "#cdd6e4", size: n.group === "domain" ? 14 : n.group === "section" ? 11 : 9 },
    shape: shape,
    _raw: n
  };
}

// Annotate join points: for each task that has 2+ incoming dep edges from
// siblings in the same feature, stamp n._joinInputs so makeVisNode renders
// it as a diamond with a ⊲N badge.
function annotateJoinNodes(nodes, edges) {
  var parentOf = {};
  edges.forEach(function(e) {
    if (e._anchor || e.type) return;
    parentOf[e.to] = e.from;
  });
  var siblingInCount = {};
  edges.forEach(function(e) {
    if (e.type !== "depends") return;
    if (!parentOf[e.from] || !parentOf[e.to]) return;
    if (parentOf[e.from] !== parentOf[e.to]) return;
    siblingInCount[e.to] = (siblingInCount[e.to] || 0) + 1;
  });
  nodes.forEach(function(n) {
    if (n.group !== "work") return;
    if (n.workKind !== "task" && n.workKind !== "issue" && n.workKind !== "spike") return;
    var c = siblingInCount[n.id] || 0;
    if (c >= 2) n._joinInputs = c;
  });
}

// Edge length biases where connected nodes settle. Longer edges → nodes drift
// farther apart. We lengthen the domain→factory and factory→work edges so the
// work-item cluster lives on the periphery instead of competing with sections
// for the center.
function edgeLength(e, nodeIndex) {
  var a = nodeIndex[e.from];
  var b = nodeIndex[e.to];
  var ga = a && a.group;
  var gb = b && b.group;
  var touchesFactory = ga === "factory" || gb === "factory";
  var touchesWork = ga === "work" || gb === "work";
  if (touchesFactory && (ga === "domain" || gb === "domain")) return 320;
  if (touchesFactory && touchesWork) return 220;
  if (touchesWork && touchesWork && e.type === "depends") return 160;
  if (touchesWork) return 200;
  return undefined;
}

function makeVisEdge(e, nodeIndex) {
  if (e._anchor) {
    // Anchor spokes: invisible but exert spring force to keep every domain
    // tethered to the pack center. Length ~ half the viewport-ish radius.
    return {
      from: e.from,
      to: e.to,
      color: { color: "rgba(0,0,0,0)", opacity: 0 },
      width: 0,
      length: 500,
      smooth: false,
      chosen: false,
      selectionWidth: 0,
    };
  }
  var len = edgeLength(e, nodeIndex);
  var edge = {
    from: e.from,
    to: e.to,
    color: { color: e.type === "depends" ? "#7aa2f7" : "#1d2230" },
    dashes: e.type === "depends",
    arrows: e.type === "depends" ? { to: { enabled: true, scaleFactor: 0.5 } } : undefined,
    width: e.type === "depends" ? 1.5 : 0.8,
    // Preserve original edge type so applyRouteHighlight can derive the
    // correct styling from first principles instead of reading mutable fields.
    _type: e.type || "hierarchy"
  };
  if (len !== undefined) edge.length = len;
  return edge;
}

// A sentinel id used only in the combined view. We inject a heavy, invisible
// anchor node at this id and link every domain to it so the whole pack
// physics-settles around the viewport center instead of drifting apart.
var PACK_ANCHOR_ID = "anchor:pack";

function combineDatasets(datasets) {
  var allNodes = [];
  var allEdges = [];
  var allBodies = {};
  var secCount = 0, entCount = 0, workCount = 0;
  var seen = {};
  datasets.forEach(function(d) {
    (d.nodes || []).forEach(function(n) {
      if (seen[n.id]) return;
      seen[n.id] = 1;
      // Tag the node's source domain so panels can show provenance.
      var copy = Object.assign({}, n, { _domain: d.domain, _domainLabel: d.label });
      allNodes.push(copy);
    });
    (d.edges || []).forEach(function(e) { allEdges.push(e); });
    Object.keys(d.bodies || {}).forEach(function(k) { allBodies[k] = d.bodies[k]; });
    secCount += d.sectionCount || 0;
    entCount += d.entryCount || 0;
    workCount += d.workCount || 0;
  });

  // Inject the invisible central anchor + a hidden spoke to every domain.
  allNodes.push({
    id: PACK_ANCHOR_ID,
    group: "anchor",
    label: "",
    meta: { type: "Anchor" },
  });
  allNodes.forEach(function(n) {
    if (n.group === "domain") {
      allEdges.push({ from: PACK_ANCHOR_ID, to: n.id, _anchor: true });
    }
  });

  return {
    domain: "__all__",
    label: "All domains (" + datasets.length + ")",
    nodes: allNodes,
    edges: allEdges,
    bodies: allBodies,
    sectionCount: secCount,
    entryCount: entCount,
    workCount: workCount,
    isCombined: true,
    datasets: datasets,
  };
}

// Which node groups the active mode allows into the vis-network viewport.
// Anchor is kept in both modes to preserve the all-domains centering physics.
function visibleGroupsForMode() {
  if (typeof getMode === "function" && getMode() === "work") {
    return { domain: 1, factory: 1, work: 1, anchor: 1 };
  }
  return { domain: 1, section: 1, entry: 1, anchor: 1 };
}

// Drop nodes whose group is hidden in the active mode, and drop edges whose
// endpoints are no longer in the visible set. Dependency edges (type=depends)
// only exist between work nodes, so they naturally appear only in Work mode.
//
// In Work mode, also hide the direct parent→child hierarchy edge when the
// child has an incoming dependency from a sibling (same parent). The dep
// chain already provides the visual path parent → leaf-prereq → … → child,
// so the shortcut edge would just clutter the graph.
function filterDatasetForMode(ds) {
  var vis = visibleGroupsForMode();
  var kept = {};
  var nodes = ds.nodes.filter(function(n) {
    var keep = !!vis[n.group];
    if (keep) kept[n.id] = 1;
    return keep;
  });
  var edges = ds.edges.filter(function(e) { return kept[e.from] && kept[e.to]; });

  if (typeof getMode === "function" && getMode() === "work") {
    var parentOf = {};
    edges.forEach(function(e) {
      if (e.type || e._anchor) return;
      parentOf[e.to] = e.from;
    });
    var hasSiblingDep = {};
    edges.forEach(function(e) {
      if (e.type !== "depends") return;
      if (parentOf[e.from] && parentOf[e.to] && parentOf[e.from] === parentOf[e.to]) {
        hasSiblingDep[e.to] = 1;
      }
    });
    edges = edges.filter(function(e) {
      if (e.type || e._anchor) return true;
      return !hasSiblingDep[e.to];
    });
  }

  return { nodes: nodes, edges: edges };
}

function render(domain) {
  var ds;
  if (domain === "__all__") {
    ds = combineDatasets(DATA);
  } else {
    ds = DATA.find(function(d) { return d.domain === domain; });
  }
  if (!ds) return;
  currentDS = ds;
  parentIndex = buildParentIndex(ds);

  // Filter per active mode BEFORE building vis DataSets. ds itself stays
  // whole so tree/breadcrumb/reader (which also consume currentDS) can decide
  // their own mode behavior in later tasks.
  var filtered = filterDatasetForMode(ds);
  // Annotate join points on the UNFILTERED edge set so sibling-dep counts
  // are computed before the hierarchy-edge pruning happens.
  annotateJoinNodes(filtered.nodes, ds.edges);
  var idx = buildNodeIndex(filtered.nodes);
  nodesDS = new vis.DataSet(filtered.nodes.map(makeVisNode));
  edgesDS = new vis.DataSet(filtered.edges.map(function(e) { return makeVisEdge(e, idx); }));

  var container = document.getElementById("graph");
  network = new vis.Network(container, { nodes: nodesDS, edges: edgesDS }, {
    physics: {
      solver: "forceAtlas2Based",
      forceAtlas2Based: { gravitationalConstant: -40, centralGravity: 0.005, springLength: 80, damping: 0.6 },
      // Stop once nodes are nearly still, and settle before first paint.
      minVelocity: 1,
      maxVelocity: 30,
      stabilization: { iterations: 400 }
    },
    interaction: Object.assign({
      hover: true,
      tooltipDelay: 200,
      selectConnectedEdges: false,
      multiselect: false,
      dragView: true,
      zoomView: true,
    }, (typeof isMobileView === "function" && isMobileView()) ? {
      hover: false,              // no hover state on touch
      tooltipDelay: 1500,        // avoid tooltip-flash on quick taps
      zoomSpeed: 0.5,            // steadier pinch zoom
      selectConnectedEdges: false,
    } : {})
  });

  network.on("click", function(params) {
    if (params.nodes.length === 0) {
      // Click on empty graph space deselects: clear the route highlight,
      // breadcrumb, synthetic return edges, and the reader panel.
      if (typeof setSelected === "function") setSelected(null);
      if (typeof clearPanel === "function") clearPanel();
      return;
    }
    var node = nodesDS.get(params.nodes[0]);
    if (node && node._raw && node._raw.group !== "anchor") showNode(node._raw);
  });

  network.on("doubleClick", function(params) {
    if (params.nodes.length === 0) return;
    var node = nodesDS.get(params.nodes[0]);
    if (node && node._raw && node._raw.group !== "anchor") showModal(node._raw);
  });

  var statPrefix = ds.isCombined ? (DATA.length + " domains · ") : "";
  document.getElementById("stats").textContent =
    statPrefix +
    ds.sectionCount + " sections, " + ds.entryCount + " entries" +
    (ds.workCount > 0 ? ", " + ds.workCount + " work items" : "");

  buildTree(ds);
}

`;
