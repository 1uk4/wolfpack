import type { FieldRenderer } from "./types";

/**
 * Console field-kind registry: one renderer per card answer kind. To add a kind, write `<kind>.tsx` here exporting a
 * renderer, and register it in index.ts (or call `registerFieldRenderer` at startup). A kind nobody registered renders
 * as a free-text answer with its question shown, so a console older than the wolf still works.
 */
const renderers = new Map<string, FieldRenderer>();
let fallback: FieldRenderer | undefined;

export function registerFieldRenderer(kind: string, Renderer: FieldRenderer): void {
	renderers.set(kind, Renderer);
}
export function unregisterFieldRenderer(kind: string): void {
	renderers.delete(kind);
}
export function setFallbackFieldRenderer(Renderer: FieldRenderer): void {
	fallback = Renderer;
}
export function fieldRenderer(kind: string): FieldRenderer {
	return renderers.get(kind) ?? fallback ?? (() => null);
}
