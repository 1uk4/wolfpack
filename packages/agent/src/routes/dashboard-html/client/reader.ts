export const READER_JS = `// Populate the panel contents (does NOT toggle open state).
// Parent-link chip at the top of the reader: tapping it re-selects the parent,
// which truncates the route by one level and re-renders the viewer.
function renderPanelParent(raw) {
  var box = document.getElementById("panel-parent");
  box.innerHTML = "";
  box.classList.remove("active");
  if (!raw || !currentDS) return;
  var parentId = parentIndex[raw.id];
  if (!parentId) return;
  var parent = (currentDS.nodes || []).find(function(n) { return n.id === parentId; });
  if (!parent) return;
  var label = parent.label || (parent.meta && parent.meta.title) || parent.id;
  box.innerHTML = '<span class="pp-arrow">└─</span>' +
                  '<span>Up to</span>' +
                  '<span class="pp-label">' + escapeHtml(label) + '</span>';
  box.title = "Up to " + label;
  box.classList.add("active");
  box.onclick = function() {
    if (network) {
      network.selectNodes([parentId]);
      network.focus(parentId, { scale: 1.3, animation: true });
    }
    showNode(parent);
  };
}

// Groups visible in the current mode. Reader-panel navigation only surfaces
// children that match the active mode so we don't offer section/entry links
// from a Work-mode view and vice versa.
function visibleGroupsForReader() {
  if (typeof getMode === "function" && getMode() === "work") {
    return { domain: 1, factory: 1, work: 1 };
  }
  return { domain: 1, section: 1, entry: 1 };
}

// Immediate hierarchical children of a node, restricted to the active mode.
// Dependency edges and anchor spokes are always skipped.
function immediateChildren(nodeId) {
  if (!currentDS) return [];
  var vis = visibleGroupsForReader();
  var out = [];
  var nodeMap = {};
  (currentDS.nodes || []).forEach(function(n) { nodeMap[n.id] = n; });
  (currentDS.edges || []).forEach(function(e) {
    if (e.from !== nodeId) return;
    if (e.type === "depends") return;
    if (e._anchor) return;
    var child = nodeMap[e.to];
    if (child && vis[child.group]) out.push(child);
  });
  // Sections / factory first (shallower navigation targets), then leaves.
  var order = { section: 0, factory: 0, work: 1, entry: 1 };
  out.sort(function(a, b) {
    var oa = (a.group in order) ? order[a.group] : 9;
    var ob = (b.group in order) ? order[b.group] : 9;
    if (oa !== ob) return oa - ob;
    return String(a.label || "").localeCompare(String(b.label || ""));
  });
  return out;
}

function renderPanelChildren(raw) {
  var box = document.getElementById("panel-children");
  box.innerHTML = "";
  box.classList.remove("active");
  if (!raw) return;
  var kids = immediateChildren(raw.id);
  if (kids.length === 0) return;
  // Count containers vs leaves (children-of-children count) for the header.
  var containerCount = 0, leafCount = 0;
  kids.forEach(function(k) {
    if (immediateChildren(k.id).length > 0) containerCount++;
    else leafCount++;
  });
  var mode = (typeof getMode === "function" && getMode()) || "kb";
  var containerLabel, leafLabel;
  if (mode === "work") {
    containerLabel = containerCount === 1 ? "group" : "groups";
    leafLabel = leafCount === 1 ? "item" : "items";
  } else {
    containerLabel = containerCount === 1 ? "section" : "sections";
    leafLabel = leafCount === 1 ? "entry" : "entries";
  }
  var bits = [];
  if (containerCount) bits.push(containerCount + " " + containerLabel);
  if (leafCount) bits.push(leafCount + " " + leafLabel);
  var header = bits.length ? "Contents · " + bits.join(", ") : "Contents";
  var html = '<div class="pc-header">' + escapeHtml(header) + '</div>';
  kids.forEach(function(k) {
    var sub = immediateChildren(k.id).length;
    var isLeaf = sub === 0;
    var icon = isLeaf ? "•" : "▸";
    var count = isLeaf ? "" : '<span class="pc-count">' + sub + '</span>';
    var cls = "pc-row" + (isLeaf ? " pc-entry" : "");
    var label = k.label || (k.meta && k.meta.title) || k.id;
    html += '<div class="' + cls + '" data-node="' + escapeHtml(k.id) + '" title="' + escapeHtml(label) + '">' +
            '<span class="pc-icon">' + icon + '</span>' +
            '<span class="pc-label">' + escapeHtml(label) + '</span>' +
            count +
            '</div>';
  });
  box.innerHTML = html;
  box.classList.add("active");
  box.querySelectorAll("[data-node]").forEach(function(row) {
    row.addEventListener("click", function() {
      var id = row.getAttribute("data-node");
      var child = (currentDS.nodes || []).find(function(n) { return n.id === id; });
      if (!child) return;
      if (network) {
        network.selectNodes([id]);
        network.focus(id, { scale: 1.3, animation: true });
      }
      showNode(child);
    });
  });
}

// Reset the reader panel to the empty placeholder state. Used when the
// selection is cleared (e.g. clicking empty graph space).
function clearPanel() {
  var panel = document.getElementById("panel");
  if (!panel) return;
  var placeholder = panel.querySelector(".placeholder");
  var title = document.getElementById("panel-title");
  var meta = document.getElementById("panel-meta");
  var body = document.getElementById("panel-body");
  var parentBox = document.getElementById("panel-parent");
  var childrenBox = document.getElementById("panel-children");
  if (placeholder) placeholder.style.display = "";
  if (title) { title.style.display = "none"; title.textContent = ""; }
  if (meta) { meta.style.display = "none"; meta.innerHTML = ""; }
  if (body) { body.style.display = "none"; body.innerHTML = ""; }
  if (parentBox) { parentBox.classList.remove("active"); parentBox.innerHTML = ""; }
  if (childrenBox) { childrenBox.classList.remove("active"); childrenBox.innerHTML = ""; }
}

function populatePanel(raw) {
  var panel = document.getElementById("panel");
  var placeholder = panel.querySelector(".placeholder");
  var title = document.getElementById("panel-title");
  var meta = document.getElementById("panel-meta");
  var body = document.getElementById("panel-body");

  placeholder.style.display = "none";
  title.style.display = "block";
  meta.style.display = "block";
  body.style.display = "block";

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

  renderPanelParent(raw);
  renderPanelChildren(raw);

  var content = currentDS.bodies ? (currentDS.bodies["ent:" + raw.id] || currentDS.bodies["work:" + raw.id] || currentDS.bodies[raw.id] || "") : "";
  body.innerHTML = content ? marked.parse(content) : "<em>No content</em>";
}

// Called whenever a node is "selected" (graph click, tree click, etc.).
// Updates route, breadcrumb, graph highlight, panel contents (if open), and
// expands the tree branch (if open).
function showNode(raw) {
  setSelected(raw.id);
  if (document.getElementById("panel").classList.contains("open")) populatePanel(raw);
  if (document.getElementById("tree").classList.contains("open")) expandTreeToSelected();
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

`;
