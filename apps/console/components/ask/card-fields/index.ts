"use client";

import { ConfirmRenderer } from "./confirm";
import { FreeTextRenderer } from "./free-text";
import { MultiRenderer } from "./multi";
import { registerFieldRenderer, setFallbackFieldRenderer } from "./registry";
import { SingleRenderer } from "./single";

export { fieldRenderer, registerFieldRenderer, unregisterFieldRenderer } from "./registry";
export type { FieldRendererProps, FieldRenderer } from "./types";
export { CardTextInput } from "./shared";

registerFieldRenderer("free-text", FreeTextRenderer);
registerFieldRenderer("single", SingleRenderer);
registerFieldRenderer("multi", MultiRenderer);
registerFieldRenderer("confirm", ConfirmRenderer);
setFallbackFieldRenderer(FreeTextRenderer);
