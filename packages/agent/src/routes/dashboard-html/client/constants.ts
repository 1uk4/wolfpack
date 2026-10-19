export const CONSTANTS_JS = `const MATURITY_COLORS = { live: "#9ece6a", stub: "#e0af68", draft: "#bb9af7", deprecated: "#7a8290" };
const WORK_DONE_STAGES = ["shipped", "live", "archived"];
const WORK_DONE_COLOR = "#73c99a"; // green — shipped/live tasks read as "done"
const WORK_ARCHIVED_COLOR = "#565f89"; // muted slate for the rare archived item
const WORK_KIND_COLORS = { initiative: "#ff9e64", feature: "#bb9af7", task: "#73daca", issue: "#f7768e", spike: "#7dcfff", idea: "#e0af68" };
let DATA = [];
let network = null;
let nodesDS = null;
let edgesDS = null;
let currentDS = null;
let selectedNodeId = null;    // the currently "selected" node (route tail)
let routeNodeIds = new Set(); // ids along Domain → ... → selected
let routeEdgeKeys = new Set();// "from|to" keys of edges along the route
let parentIndex = {};         // child id → parent id (hierarchical, not deps)

`;
