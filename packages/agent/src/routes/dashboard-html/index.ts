import { HEAD_HTML } from "./head.js";
import { STYLES_CSS } from "./styles.js";
import { LAYOUT_HTML } from "./layout.js";
import { CONSTANTS_JS } from "./client/constants.js";
import { MODE_JS } from "./client/mode.js";
import { GRAPH_JS } from "./client/graph.js";
import { TREE_JS } from "./client/tree.js";
import { READER_JS } from "./client/reader.js";
import { DROPDOWN_INIT_JS } from "./client/boot-dropdown.js";
import { ROUTE_JS } from "./client/route.js";
import { OVERLAYS_JS } from "./client/overlays.js";
import { BOOT_JS } from "./client/boot.js";
import { FOOT_HTML } from "./foot.js";

export const DASHBOARD_HTML =
  HEAD_HTML +
  STYLES_CSS +
  LAYOUT_HTML +
  CONSTANTS_JS +
  MODE_JS +
  GRAPH_JS +
  TREE_JS +
  READER_JS +
  DROPDOWN_INIT_JS +
  ROUTE_JS +
  OVERLAYS_JS +
  BOOT_JS +
  FOOT_HTML;
