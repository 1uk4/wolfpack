import type { ReactNode } from "react";
/** Home and the draft share one wrapping action row. Picker controls lead;
 * setup is centered only when it is the sole action. */
export declare function ComposerActions({ picker, setup }: {
    picker?: ReactNode;
    setup?: ReactNode;
}): any;
/** Count and Clear stay together if the setup action wraps onto another line.
 * These are node counts, even when a whole chain supplied the selection. */
export declare function NodePickerControl({ count, onOpen, onClear }: {
    count: number;
    onOpen?: () => void;
    onClear?: () => void;
}): any;
//# sourceMappingURL=composer-actions.d.ts.map