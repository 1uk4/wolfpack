export const DROPDOWN_INIT_JS = `// Init
var sel = document.getElementById("domainSelect");
sel.addEventListener("change", function() {
  selectedNodeId = null; routeNodeIds = new Set(); routeEdgeKeys = new Set();
  updateBreadcrumb();
  render(sel.value);
});

`;
