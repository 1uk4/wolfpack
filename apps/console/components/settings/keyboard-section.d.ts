import { type KeyAction } from "@/src/core";
/** The overrides map after ONE change (pure — exported for tests):
 *  binding null = reset the action to its default (key removed). */
export declare function nextOverrides(current: Partial<Record<KeyAction, string>>, id: KeyAction, binding: string | null): Partial<Record<KeyAction, string>>;
export declare function KeyboardSection(): any;
//# sourceMappingURL=keyboard-section.d.ts.map