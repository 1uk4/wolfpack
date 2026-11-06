import type { ComponentType } from "react";
import type { CardField, CardFieldAnswer } from "@wolfpack/client";
import type { FieldDictation } from "./shared";

/**
 * What a field renderer gets. One renderer per answer kind (see registry.ts); `compact` asks for the tight variant
 * (the floating chat bar, phone): same control, less chrome.
 */
export interface FieldRendererProps<F extends { kind: string } = CardField> {
	field: F;
	value: CardFieldAnswer | undefined;
	readOnly: boolean;
	onChange: (a: CardFieldAnswer) => void;
	onClear: () => void;
	/** Id of the element labelling the control (aria-labelledby). */
	labelledBy: string;
	compact?: boolean;
	/** Text typed into the kind's "Other…" box but not yet added (multi). */
	typed: string;
	onType: (text: string) => void;
	onAddCustom?: () => void;
	/** The kind's pending text error (multi custom entry). */
	error?: string;
	dictation: FieldDictation;
}
export type FieldRenderer = ComponentType<FieldRendererProps<any>>;
