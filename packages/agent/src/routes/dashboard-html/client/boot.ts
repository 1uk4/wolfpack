export const BOOT_JS = `document.getElementById("fileToggle").addEventListener("click", toggleFile);
document.getElementById("readerToggle").addEventListener("click", toggleReader);
document.getElementById("modal-close").addEventListener("click", hideModal);
document.getElementById("modal-overlay").addEventListener("click", function(e) {
  if (e.target.id === "modal-overlay") hideModal();
});
document.addEventListener("keydown", function(e) { if (e.key === "Escape") hideModal(); });

// Mode toggle: KB <-> Work re-renders the graph with the per-mode filter.
// Selection is cleared on switch to avoid pointing at a now-hidden node.
document.addEventListener("mode-change", function() {
  selectedNodeId = null;
  routeNodeIds = new Set();
  routeEdgeKeys = new Set();
  updateBreadcrumb();
  if (sel.value) render(sel.value);
});

// Fetch data
fetch("/dashboard/api/kb-graph")
  .then(function(r) { return r.json(); })
  .then(function(data) {
    DATA = data;
    sel.innerHTML = "";
    // "All domains" is the default landing view.
    if (DATA.length > 1) {
      var allOpt = document.createElement("option");
      allOpt.value = "__all__";
      var totalEntries = DATA.reduce(function(n, d) { return n + (d.entryCount || 0); }, 0);
      allOpt.textContent = "All domains (" + totalEntries + " entries)";
      sel.appendChild(allOpt);
    }
    DATA.forEach(function(d) {
      var o = document.createElement("option");
      o.value = d.domain;
      o.textContent = d.label + " (" + d.entryCount + " entries)";
      sel.appendChild(o);
    });
    if (DATA.length) {
      sel.value = DATA.length > 1 ? "__all__" : DATA[0].domain;
      render(sel.value);
    }
  })
  .catch(function(e) { console.error("Failed to load:", e); });
`;
