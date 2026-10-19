export const OVERLAYS_JS = `// ── Overlay toggles (file viewer / reader) ───────────────────────────────────────────
// Mobile check (also used by the overlay toggles to enforce single-view).
function isMobileView() { return window.matchMedia("(max-width: 768px)").matches; }

// On desktop both buttons toggle independently (overlays sit on top of the
// graph alongside each other). On mobile the two overlays are mutually
// exclusive — opening one closes the other — so the active screen fully
// replaces whatever was showing, matching single-view navigation.
function updateOverlayState() {
  var tOpen = document.getElementById("tree").classList.contains("open");
  var pOpen = document.getElementById("panel").classList.contains("open");
  document.getElementById("fileToggle").classList.toggle("active", tOpen);
  document.getElementById("readerToggle").classList.toggle("active", pOpen);
  document.body.classList.toggle("has-overlay", tOpen || pOpen);
}
function toggleFile() {
  var tree = document.getElementById("tree");
  var panel = document.getElementById("panel");
  if (tree.classList.contains("open")) {
    tree.classList.remove("open");
  } else {
    // Mobile: enforce single-view — close the reader if it was up.
    if (isMobileView()) panel.classList.remove("open");
    if (currentDS) buildTree(currentDS); // render with current route marked
    tree.classList.add("open");
    // Auto-expand to the selected node's branch.
    expandTreeToSelected();
  }
  updateOverlayState();
}
function toggleReader() {
  var panel = document.getElementById("panel");
  var tree = document.getElementById("tree");
  if (panel.classList.contains("open")) {
    panel.classList.remove("open");
  } else {
    // Mobile: enforce single-view — close the file viewer if it was up.
    if (isMobileView()) tree.classList.remove("open");
    panel.classList.add("open");
    // If a node is already selected, make sure its content is populated.
    if (selectedNodeId && currentDS) {
      var raw = (currentDS.nodes || []).find(function(n) { return n.id === selectedNodeId; });
      if (raw) populatePanel(raw);
    }
  }
  updateOverlayState();
}

// Viewport-resize guard: when a user flips from mobile to desktop width while
// one overlay was replacing the graph, keep both open-states intact; the CSS
// swap handles the visual difference. Nothing to do here beyond redrawing the
// network so vis fits the new graph area.
window.addEventListener("resize", function() {
  if (network) network.redraw();
});
function expandTreeToSelected() {
  if (!selectedNodeId) return;
  var treeEl = document.getElementById("tree");
  routeNodeIds.forEach(function(id) {
    var row = treeEl.querySelector('[data-node="' + CSS.escape(id) + '"]');
    if (!row) return;
    var kids = row.nextElementSibling;
    if (kids && kids.classList.contains("tree-children")) {
      kids.classList.add("open");
      var arrow = row.querySelector(".arrow");
      if (arrow) arrow.classList.add("open");
    }
  });
  var tail = treeEl.querySelector('[data-node="' + CSS.escape(selectedNodeId) + '"]');
  if (tail) tail.scrollIntoView({ block: "center", behavior: "smooth" });
}

`;
