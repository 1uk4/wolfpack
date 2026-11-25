import { registerViewRenderer } from "./registry";
import { KbEntryViewRenderer } from "./renderers/kb-entry-view";
import { PromptViewRenderer } from "./renderers/prompt-view";
import { WorkItemViewRenderer } from "./renderers/work-item-view";

registerViewRenderer("work", WorkItemViewRenderer);
registerViewRenderer("kb", KbEntryViewRenderer);
registerViewRenderer("prompt", PromptViewRenderer);
