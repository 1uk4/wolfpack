import { registerViewRenderer } from "./registry";
import { WorkItemViewRenderer } from "./renderers/work-item-view";

registerViewRenderer("work", WorkItemViewRenderer);
