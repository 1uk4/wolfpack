export const ROUTE_JS = `// ── Route tracking ──────────────────────────────────────────────────────────
// Hierarchical parent chain: for a given node, walk back to its domain root
// along non-dependency edges. The chain of nodes + the edges joining them is
// "the route", which drives the breadcrumb, the tree expansion, and the red
// highlight on the graph.
function buildParentIndex(ds) {
  var idx = {};
  (ds.edges || []).forEach(function(e) {
    if (e.type === "depends") return; // dependency links are not parentage
    if (e._anchor) return;             // invisible anchor spokes are not parentage
    // Only the first incoming hierarchical edge counts as parent.
    if (!(e.to in idx)) idx[e.to] = e.from;
  });
  return idx;
}
function routeFor(nodeId) {
  var chain = [];
  var seen = new Set();
  var cur = nodeId;
  while (cur && !seen.has(cur)) {
    chain.unshift(cur);
    seen.add(cur);
    cur = parentIndex[cur];
  }
  return chain;
}
// The longest chain of prereqs ending at nodeId: [leaf, ..., nodeId].
// Reads left-to-right as the completion order: do the leaf first, then
// each next task, finally reach the selected node.
function longestDependencyPath(nodeId) {
  if (!currentDS) return [nodeId];
  var incoming = {};
  (currentDS.edges || []).forEach(function(e) {
    if (e.type !== "depends") return;
    if (!incoming[e.to]) incoming[e.to] = [];
    incoming[e.to].push(e.from);
  });
  var cache = {};
  function longest(n, seen) {
    if (cache[n]) return cache[n];
    if (seen.has(n)) return [n]; // cycle guard
    var preds = incoming[n] || [];
    if (preds.length === 0) return [n];
    var newSeen = new Set(seen); newSeen.add(n);
    var best = [n];
    for (var i = 0; i < preds.length; i++) {
      var sub = longest(preds[i], newSeen);
      if (sub.length + 1 > best.length) best = sub.concat([n]);
    }
    cache[n] = best;
    return best;
  }
  return longest(nodeId, new Set());
}

// Walk back through depends-type edges from a work node to find every
// transitive prerequisite — and when a prerequisite is a feature (or any
// container), descend into its hierarchical children so the route also
// "walks through" the dependent tasks that make up the feature. Any dep
// edges that exist entirely within the collected closure are also marked
// as route edges. Hierarchy edges from an expanded parent to its visible
// children are included so the walk-through is drawn as one continuous path.
function dependencyPredecessors(nodeId) {
  var nodes = new Set();
  var edges = new Set();
  if (!currentDS) return { nodes: nodes, edges: edges };

  var nodeById = {};
  (currentDS.nodes || []).forEach(function(n) { nodeById[n.id] = n; });

  var depIncoming = {};
  var childrenOf = {};
  (currentDS.edges || []).forEach(function(e) {
    if (e._anchor) return;
    if (e.type === "depends") {
      if (!depIncoming[e.to]) depIncoming[e.to] = [];
      depIncoming[e.to].push(e.from);
    } else if (!e.type) {
      if (!childrenOf[e.from]) childrenOf[e.from] = [];
      childrenOf[e.from].push(e.to);
    }
  });

  // A container is a feature/initiative/factory — a node whose dep means
  // "all of its tasks must be done" rather than a single leaf unit.
  function isContainer(n) {
    if (!n) return false;
    if (n.group === "factory") return true;
    if (n.group !== "work") return false;
    return n.workKind === "feature" || n.workKind === "initiative";
  }

  var seen = new Set([nodeId]);
  var queue = [nodeId];

  function expandChildren(parentId) {
    var stack = [parentId];
    while (stack.length) {
      var p = stack.pop();
      var kids = childrenOf[p] || [];
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        edges.add(p + "|" + c); // hierarchy edge inside the closure
        if (seen.has(c)) continue;
        seen.add(c);
        nodes.add(c);
        queue.push(c); // tasks inside may themselves have deps to walk
        stack.push(c);
      }
    }
  }

  while (queue.length) {
    var cur = queue.shift();
    var preds = depIncoming[cur] || [];
    for (var i = 0; i < preds.length; i++) {
      var p = preds[i];
      edges.add(p + "|" + cur);
      if (seen.has(p)) continue;
      seen.add(p);
      nodes.add(p);
      queue.push(p);
      if (isContainer(nodeById[p])) expandChildren(p);
    }
  }

  // Pick up any dep edges between members of the closure that weren't
  // walked directly (e.g. task-level deps inside a container we expanded).
  (currentDS.edges || []).forEach(function(e) {
    if (e.type !== "depends") return;
    if (seen.has(e.from) && seen.has(e.to)) edges.add(e.from + "|" + e.to);
  });

  return { nodes: nodes, edges: edges };
}

// The chain used for breadcrumb display. Set at selection time so that
// updateBreadcrumb and other consumers see the mode-appropriate path.
var breadcrumbChain = [];

// Nodes inside the route that are parallelizable — siblings within the same
// container that have no dep edges to other included siblings. Highlighted in
// a distinct color (amber) so you can see "these can run in parallel" at a
// glance, while the strict completion path stays red.
var routeParallelNodes = new Set();
var routeParallelEdges = new Set();

// Synthetic edge ids we injected on the previous selection, so we can clean
// them up before injecting a new set.
var syntheticEdgeIds = [];

// Parallel marking only applies to TASK siblings under a feature parent.
// Features-under-initiative are NEVER marked parallel (features are the
// containers you walk through, not parallel work units themselves). Only the
// parent→task hierarchy edge gets amber; dep edges downstream from the
// parallel group stay red (they're part of the strict completion path to the
// join).
function computeParallelMarks() {
  routeParallelNodes = new Set();
  routeParallelEdges = new Set();
  if (!currentDS || routeNodeIds.size === 0) return;

  var nodeById = {};
  (currentDS.nodes || []).forEach(function(n) { nodeById[n.id] = n; });

  var parentOf = {};
  var depIncoming = {};
  (currentDS.edges || []).forEach(function(e) {
    if (e._anchor) return;
    if (!e.type) { parentOf[e.to] = e.from; return; }
    if (e.type === "depends") {
      if (!depIncoming[e.to]) depIncoming[e.to] = new Set();
      depIncoming[e.to].add(e.from);
    }
  });

  function isTaskLike(n) {
    if (!n || n.group !== "work") return false;
    return n.workKind === "task" || n.workKind === "issue" || n.workKind === "spike";
  }
  function isFeatureLike(n) {
    if (!n || n.group !== "work") return false;
    return n.workKind === "feature" || n.workKind === "initiative";
  }

  // Group only task-level route siblings whose parent is a feature.
  var siblingsByParent = {};
  routeNodeIds.forEach(function(id) {
    var child = nodeById[id];
    if (!isTaskLike(child)) return;
    var p = parentOf[id];
    if (!p || !routeNodeIds.has(p)) return;
    if (!isFeatureLike(nodeById[p])) return;
    if (!siblingsByParent[p]) siblingsByParent[p] = [];
    siblingsByParent[p].push(id);
  });

  // A task is parallel only if it's a FAN-OUT STARTER: no incoming dep from
  // any sibling under the same feature. Chain-middle and chain-tail tasks
  // (which have an incoming sibling-dep) are sequentially gated — they stay
  // red. Mark only when 2+ starters exist (otherwise there's nothing to run
  // in parallel with).
  Object.keys(siblingsByParent).forEach(function(parentId) {
    var sibs = siblingsByParent[parentId];
    if (sibs.length < 2) return;
    var sibSet = new Set(sibs);
    var starters = [];
    sibs.forEach(function(id) {
      var ins = depIncoming[id] || new Set();
      var hasSiblingIncoming = false;
      ins.forEach(function(src) { if (sibSet.has(src)) hasSiblingIncoming = true; });
      if (!hasSiblingIncoming) starters.push(id);
    });
    if (starters.length < 2) return;
    starters.forEach(function(id) {
      routeParallelNodes.add(id);
      var key = parentId + "|" + id;
      routeParallelEdges.add(key);
      // Make sure every parallel starter's parent→task edge counts as
      // on-route so applyRouteHighlight picks up the amber color (otherwise
      // only the one picked as hierarchy anchor would be on-route).
      routeEdgeKeys.add(key);
    });
  });
}

function setSelected(nodeId) {
  selectedNodeId = nodeId;
  routeNodeIds = new Set();
  routeEdgeKeys = new Set();
  breadcrumbChain = [];

  if (!nodeId) {
    // Clear any synthetic return edges left over from the previous selection.
    injectReturnEdges();
    updateBreadcrumb();
    applyRouteHighlight();
    return;
  }

  // In Work mode with a dep chain, the hierarchy route anchors on the LEAF
  // prereq (the start of work) rather than the selected node. Both share the
  // same feature parent, but the entry-point into the chain is the leaf.
  var depPath = [];
  var depPreds = { nodes: new Set(), edges: new Set() };
  if (typeof getMode === "function" && getMode() === "work") {
    // Walk predecessor closures for the selected AND every hierarchy ancestor:
    // reaching this node requires its parent feature's work, which requires
    // that feature's dep prereqs, which may in turn be features with their own
    // task chains. Selecting a task without direct deps still lights up all
    // the ancestor-level work that has to happen first.
    var seeds = [nodeId];
    var cur = parentIndex[nodeId];
    while (cur) { seeds.push(cur); cur = parentIndex[cur]; }
    seeds.forEach(function(seed) {
      var p = dependencyPredecessors(seed);
      p.nodes.forEach(function(n) { depPreds.nodes.add(n); });
      p.edges.forEach(function(e) { depPreds.edges.add(e); });
    });
    if (depPreds.nodes.size > 0) depPath = longestDependencyPath(nodeId);
  }

  var hierarchyAnchor = depPath.length > 0 ? depPath[0] : nodeId;
  var hierarchyChain = routeFor(hierarchyAnchor);
  hierarchyChain.forEach(function(id) { routeNodeIds.add(id); });
  for (var i = 1; i < hierarchyChain.length; i++) {
    routeEdgeKeys.add(hierarchyChain[i - 1] + "|" + hierarchyChain[i]);
  }

  // Add the full dep predecessor tree so every prereq lights up (not just
  // the longest-path branch), and connect the dep-chain edges.
  depPreds.nodes.forEach(function(id) { routeNodeIds.add(id); });
  depPreds.edges.forEach(function(k) { routeEdgeKeys.add(k); });
  // Make sure the selected node is on-route even if it has no deps.
  routeNodeIds.add(nodeId);

  // Breadcrumb: hierarchy ancestors of the leaf, then the completion path
  // leaf → ... → selected. Reads left-to-right as location + work order.
  if (depPath.length > 0) {
    breadcrumbChain = hierarchyChain.slice(0, -1).concat(depPath);
  } else {
    breadcrumbChain = hierarchyChain;
  }

  computeParallelMarks();
  injectReturnEdges();
  updateBreadcrumb();
  applyRouteHighlight();
  if (document.getElementById("tree").classList.contains("open") && currentDS) {
    buildTree(currentDS);
  }
}

// For each feature in the route, find terminal TASKS of its internal dep
// chain — tasks that have incoming deps from siblings (meaning there's a
// jump of dependencies ending at this task) AND no outgoing deps to siblings
// (nothing downstream in-feature). Inject a synthetic edge from each such
// task back to its parent feature so the route visually completes the loop.
//
// Rules:
//   • Return arrows ORIGINATE from tasks only (not features/initiatives).
//   • A task gets a return arrow only if a sibling-dep chain terminates in it.
//     Tasks with no incoming sibling deps (floating / fully parallel) do not
//     get a return arrow — they float on their own hierarchy edge.
function injectReturnEdges() {
  if (!edgesDS) return;
  if (syntheticEdgeIds.length) {
    try { edgesDS.remove(syntheticEdgeIds); } catch (_e) { /* already gone */ }
    syntheticEdgeIds = [];
  }
  if (!currentDS || routeNodeIds.size === 0) return;

  var nodeById = {};
  (currentDS.nodes || []).forEach(function(n) { nodeById[n.id] = n; });

  var parentOf = {};
  var childrenOf = {};
  var depOutgoing = {};
  var depIncoming = {};
  (currentDS.edges || []).forEach(function(e) {
    if (e._anchor) return;
    if (!e.type) {
      parentOf[e.to] = e.from;
      if (!childrenOf[e.from]) childrenOf[e.from] = [];
      childrenOf[e.from].push(e.to);
      return;
    }
    if (e.type === "depends") {
      if (!depOutgoing[e.from]) depOutgoing[e.from] = new Set();
      depOutgoing[e.from].add(e.to);
      if (!depIncoming[e.to]) depIncoming[e.to] = new Set();
      depIncoming[e.to].add(e.from);
    }
  });

  function isTaskLike(n) {
    if (!n || n.group !== "work") return false;
    return n.workKind === "task" || n.workKind === "issue" || n.workKind === "spike";
  }
  function isFeatureLike(n) {
    if (!n || n.group !== "work") return false;
    return n.workKind === "feature" || n.workKind === "initiative";
  }

  // Group in-route nodes by their parent, only when the parent is a feature-
  // like container (features, initiatives). Factory/domain parents do not get
  // return arrows — only feature-level containers.
  var siblingsByParent = {};
  routeNodeIds.forEach(function(id) {
    var p = parentOf[id];
    if (!p || !routeNodeIds.has(p)) return;
    var pn = nodeById[p];
    if (!isFeatureLike(pn)) return;
    if (!siblingsByParent[p]) siblingsByParent[p] = [];
    siblingsByParent[p].push(id);
  });

  var toAdd = [];
  Object.keys(siblingsByParent).forEach(function(parentId) {
    // Only emit a return arrow back to the feature if some OTHER feature
    // actually depends on this one. If nothing requires it, the final task's
    // completion is the end of the line — let it hang.
    var parentDependents = depOutgoing[parentId];
    if (!parentDependents || parentDependents.size === 0) return;

    var routeSibs = siblingsByParent[parentId];
    // Check terminal-ness against ALL siblings in the feature (from full data),
    // not just route siblings — so a selected task with a chain continuing
    // beyond the route still correctly reads as "not terminal".
    var allSibs = childrenOf[parentId] || [];
    routeSibs.forEach(function(id) {
      var child = nodeById[id];
      if (!isTaskLike(child)) return; // only tasks emit return arrows

      var outs = depOutgoing[id] || new Set();
      var ins = depIncoming[id] || new Set();
      var hasSiblingDependent = false;
      var hasSiblingDependency = false;
      for (var i = 0; i < allSibs.length; i++) {
        var other = allSibs[i];
        if (other === id) continue;
        if (outs.has(other)) hasSiblingDependent = true;
        if (ins.has(other)) hasSiblingDependency = true;
      }
      if (hasSiblingDependent) return; // chain continues past this task
      if (!hasSiblingDependency) return; // floats — no inbound hop to "close"

      var synId = "syn:" + id + "|" + parentId;
      toAdd.push({
        id: synId,
        from: id,
        to: parentId,
        _type: "return",
        color: { color: "#f7768e" },
        width: 2.5,
        dashes: false,
        arrows: { to: { enabled: true, scaleFactor: 0.5 } },
        smooth: { enabled: true, type: "curvedCW", roundness: 0.25 },
      });
      syntheticEdgeIds.push(synId);
      routeEdgeKeys.add(id + "|" + parentId);
    });
  });

  if (toAdd.length) {
    try { edgesDS.add(toAdd); } catch (_e) { /* dup ids, swallow */ }
  }
}
function updateBreadcrumb() {
  var bc = document.getElementById("breadcrumb");
  if (!selectedNodeId || !currentDS) { bc.classList.remove("active"); bc.innerHTML = ""; return; }
  var chain = (breadcrumbChain && breadcrumbChain.length) ? breadcrumbChain : routeFor(selectedNodeId);
  if (chain.length === 0) { bc.classList.remove("active"); return; }
  var nodeMap = {};
  (currentDS.nodes || []).forEach(function(n) { nodeMap[n.id] = n; });

  // Build one row per crumb. The top row (depth 0) is always visible; deeper
  // rows appear only when the breadcrumb is in the .open state. Each deeper
  // row is indented by its depth and prefixed with an L-shaped arrow (└─) to
  // visualize the jump from parent to child.
  var hasDeeper = chain.length > 1;
  var rows = chain.map(function(id, i) {
    var n = nodeMap[id];
    var label = n ? (n.label || n.meta && n.meta.title || id) : id;
    var isTail = i === chain.length - 1;
    var depth = i;
    // Indent each deeper row by 10px per level, drawn with a monospace spacer.
    var pad = depth === 0 ? "" : '<span class="crumb-depth" style="width:' + (depth * 10) + 'px"></span>';
    var arrow = depth === 0 ? "" : '<span class="crumb-arrow">└─</span>';
    // The top-row toggle chevron only on the first row AND only when deeper
    // rows exist to reveal.
    var toggle = (depth === 0 && hasDeeper)
      ? '<span class="crumb-toggle">▾</span>'
      : "";
    return '<div class="crumb-row' + (isTail ? " is-tail" : "") + '" ' +
           'data-node="' + escapeHtml(id) + '" data-depth="' + depth + '" ' +
           'title="' + escapeHtml(label) + '">' +
           pad + arrow +
           '<span class="crumb-label">' + escapeHtml(label) + '</span>' +
           toggle +
           '</div>';
  }).join("");
  bc.innerHTML = rows;
  bc.classList.add("active");
  // Only one row shown? Collapse the open-state to keep the pill compact.
  if (!hasDeeper) bc.classList.remove("open");

  // Click on a row re-selects that point in the route. Clicking the top row
  // ALSO toggles the expanded state (if there is deeper content).
  bc.querySelectorAll(".crumb-row").forEach(function(row) {
    row.addEventListener("click", function(ev) {
      ev.stopPropagation();
      var id = row.getAttribute("data-node");
      var depth = Number(row.getAttribute("data-depth"));
      // Top row with deeper rows available: toggle open/close instead of
      // immediately re-selecting (users mostly want to peek at the route).
      if (depth === 0 && hasDeeper) {
        bc.classList.toggle("open");
        return;
      }
      if (!id || !currentDS) return;
      var raw = (currentDS.nodes || []).find(function(n) { return n.id === id; });
      if (!raw) return;
      if (network) {
        network.selectNodes([id]);
        network.focus(id, { scale: 1.3, animation: true });
      }
      showNode(raw);
    });
  });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function(c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// Apply the route highlight. Strict-order route = red; parallelizable sibling
// groups = amber (do-in-any-order within a feature); non-route = base styling.
function applyRouteHighlight() {
  if (!nodesDS || !edgesDS) return;
  var ROUTE_COLOR = "#f7768e";
  var PARALLEL_COLOR = "#e0af68";
  var updates = [];
  nodesDS.forEach(function(vn) {
    var raw = vn._raw || {};
    var onRoute = routeNodeIds.has(vn.id);
    var isParallel = routeParallelNodes.has(vn.id);
    var baseColor = nodeColor(raw);
    var color = onRoute
      ? (isParallel ? PARALLEL_COLOR : ROUTE_COLOR)
      : baseColor;
    updates.push({
      id: vn.id,
      color: { background: color, border: color },
      borderWidth: onRoute ? 3 : 1,
    });
  });
  nodesDS.update(updates);

  var edgeUpdates = [];
  edgesDS.forEach(function(ve) {
    var key = ve.from + "|" + ve.to;
    var onRoute = routeEdgeKeys.has(key);
    var isParallel = routeParallelEdges.has(key);
    var isDep = ve._type === "depends";
    var color = onRoute
      ? (isParallel ? PARALLEL_COLOR : ROUTE_COLOR)
      : (isDep ? "#7aa2f7" : "#1d2230");
    edgeUpdates.push({
      id: ve.id,
      color: { color: color },
      // On-route edges render solid regardless of their underlying type so the
      // route reads as one continuous line, even through dep hops.
      dashes: onRoute ? false : isDep,
      width: onRoute ? 3 : (isDep ? 1.5 : 0.8),
    });
  });
  edgesDS.update(edgeUpdates);
}

`;
