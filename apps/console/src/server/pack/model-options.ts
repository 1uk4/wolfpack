/**
 * The models the Wolves pickers can offer (work-wolfpack-eE5FKDy): the catalog's models of the providers the Pack can hold a key for
 * and that do chat or memory. Not filtered by THIS console's keys: which provider is offered to a wolf is decided by its own machine's
 * keys (src/core/pack/wolves-model.ts). Ids and names only.
 */
import { PROVIDERS } from "@wolfpack/protocol/providers";
import { piModels } from "../../agent/models.ts";

export interface ModelOption {
	id: string;
	name: string;
	provider: string;
}

export function packModelOptions(): ModelOption[] {
	const m = piModels();
	return PROVIDERS.filter((p) => p.capabilities.some((c) => c === "chat" || c === "memory"))
		.flatMap((p) => m.getModels(p.id).map((x) => ({ id: x.id, name: x.name, provider: p.id })))
		.sort((a, b) => a.id.localeCompare(b.id));
}
