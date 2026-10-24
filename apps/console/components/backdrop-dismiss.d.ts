import { type MouseEvent, type PointerEvent } from "react";
/** A synthesized click may target the backdrop even when a drag began
 * inside the dialog. Require both endpoints of the same primary gesture.
 * Capture observes inside/portaled interactions even if they stop bubbling;
 * it never prevents their own button, menu, or selection behavior. */
export declare function useBackdropDismiss(onDismiss: () => void): {
    onPointerDownCapture(event: PointerEvent<HTMLDivElement>): void;
    onPointerUpCapture(event: PointerEvent<HTMLDivElement>): void;
    onPointerCancelCapture(): void;
    onClickCapture(event: MouseEvent<HTMLDivElement>): void;
};
//# sourceMappingURL=backdrop-dismiss.d.ts.map