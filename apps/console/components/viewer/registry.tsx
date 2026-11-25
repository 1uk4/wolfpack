import type { ComponentType } from "react";
import type { ViewDescriptor } from "./view-descriptor";

export interface ViewRendererProps {
	descriptor: ViewDescriptor;
	/** The wolf of the thread this viewer sits in; undefined on a page host. Frames load only from this wolf, never from the descriptor. */
	wolf?: string;
	/** Open another view on top of this one (back returns here). */
	onPush: (descriptor: ViewDescriptor) => void;
	/** Report the title to show in the shell header. */
	onTitle: (title: string) => void;
	/** Close the whole viewer. */
	onClose: () => void;
}

export type ViewRenderer = ComponentType<ViewRendererProps>;

const renderers = new Map<string, ViewRenderer>();

export function registerViewRenderer(kind: string, component: ViewRenderer): void {
	renderers.set(kind, component);
}

/** The renderer for `kind`; an unknown kind gets a small "No viewer for kind X" fallback. */
export function getViewRenderer(kind: string): ViewRenderer {
	return (
		renderers.get(kind) ??
		function NoViewer() {
			return (
				<p className="p-4 text-sm text-muted-foreground" role="status">
					No viewer for kind {kind}
				</p>
			);
		}
	);
}

export const hasViewRenderer = (kind: string): boolean => renderers.has(kind);

export const listViewKinds = (): string[] => [...renderers.keys()];
