export const TREE_JS = `function buildTree(ds) {
  var mode = (typeof getMode === "function" && getMode()) || "kb";
  var treeEl = document.getElementById("tree");

  // Which node groups appear in the tree for the active mode.
  var showGroups = (mode === "work")
    ? { domain: 1, factory: 1, work: 1 }
    : { domain: 1, section: 1, entry: 1 };

  // Visible nodes keyed by id.
  var visible = {};
  ds.nodes.forEach(function(n) {
    if (showGroups[n.group]) visible[n.id] = n;
  });

  // Parent→children map, visible nodes only, hierarchical edges only.
  var children = {};
  ds.edges.forEach(function(e) {
    if (e.type || e._anchor) return; // skip deps + anchor spokes
    if (!visible[e.from] || !visible[e.to]) return;
    if (!children[e.from]) children[e.from] = [];
    children[e.from].push(e.to);
  });

  // A node is a leaf iff it has no visible children. (KB entries never do;
  // Work tasks/issues/spikes/ideas usually don't.)
  function isLeaf(n) {
    var kids = children[n.id];
    return !kids || kids.length === 0;
  }

  function isDone(n) {
    return n && n.group === "work" && typeof WORK_DONE_STAGES !== "undefined" && WORK_DONE_STAGES.indexOf(n.stage) >= 0;
  }

  function renderSection(nodeId, depth) {
    var node = visible[nodeId];
    if (!node) return "";
    var kids = children[nodeId] || [];
    var containerKids = kids.filter(function(id) { return visible[id] && !isLeaf(visible[id]); });
    var leafKids = kids.filter(function(id) { return visible[id] && isLeaf(visible[id]); });
    var leafCount = leafKids.length;

    var cls = "tree-section";
    if (routeNodeIds.has(nodeId)) cls += " on-route";
    if (nodeId === selectedNodeId) cls += " selected";
    if (isDone(node)) cls += " done";
    var html = '<div class="' + cls + '" data-node="' + nodeId + '">';
    if (containerKids.length > 0 || leafKids.length > 0) {
      html += '<span class="arrow">&#9654;</span>';
    } else {
      html += '<span style="width:12px;display:inline-block"></span>';
    }
    html += '<span class="label">' + (node.label || node.id) + '</span>';
    if (leafCount > 0) html += '<span class="count">' + leafCount + '</span>';
    html += '</div>';

    if (containerKids.length > 0 || leafKids.length > 0) {
      html += '<div class="tree-children" data-parent="' + nodeId + '">';
      containerKids.forEach(function(sid) { html += renderSection(sid, depth + 1); });
      leafKids.forEach(function(eid) {
        var eNode = visible[eid];
        if (eNode) {
          var ecls = "tree-entry";
          if (routeNodeIds.has(eid)) ecls += " on-route";
          if (eid === selectedNodeId) ecls += " selected";
          if (isDone(eNode)) ecls += " done";
          html += '<div class="' + ecls + '" data-node="' + eid + '">' + escapeHtml(eNode.label || eid) + '</div>';
        }
      });
      html += '</div>';
    }
    return html;
  }

  // Build the tree per domain root. Combined view walks every domain root;
  // single-domain view walks just one.
  var domainRoots = ds.isCombined
    ? ds.nodes.filter(function(n) { return n.group === "domain"; }).map(function(n) { return { id: n.id, label: n.label }; })
    : [{ id: "dom:" + ds.domain, label: ds.label }];

  var html = "";
  domainRoots.forEach(function(root) {
    var rootKids = (children[root.id] || []).filter(function(id) {
      var n = visible[id];
      return n && !isLeaf(n);
    });
    html += '<div class="tree-domain">' + root.label + '</div>';
    rootKids.forEach(function(sid) { html += renderSection(sid, 0); });
    var orphanLeaves = (children[root.id] || []).filter(function(id) {
      var n = visible[id];
      return n && isLeaf(n);
    });
    if (orphanLeaves.length > 0) {
      html += '<div class="tree-section" style="border-left-color:#e0af68;"><span style="width:12px;display:inline-block"></span><span class="label" style="color:#e0af68;">Unplaced (' + orphanLeaves.length + ')</span></div>';
    }
  });

  treeEl.innerHTML = html;
  // (Caller controls open/close via the FAB toggle; buildTree only renders.)

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

`;
