/**
 * The console assistant's model pin: compose one slot's model/thinking override in the `models` settings section. The chat model
 * picker (model-picker.tsx) is the only writer now; the Settings dialog's slot rows are gone (per-wolf models live on /settings).
 * Empty model = absent override; empty thinking = keep the resolved budget; per-field independence. Pure.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelSlotName, ModelsSettings } from "@/src/core";

export function composeSlotModel(
	models: ModelsSettings | undefined,
	slot: ModelSlotName,
	provider: string,
	id: string,
	thinking: string,
): ModelsSettings {
	const prev = models?.[slot];
	const next = { ...models };
	if (!provider && !id && !thinking) {
		delete next[slot];
		return next;
	}
	next[slot] = {
		...(provider && id ? { model: { provider, id } } : prev?.model ? { model: prev.model } : {}),
		...(thinking ? { thinkingLevel: thinking as ThinkingLevel } : {}),
	};
	return next;
}
