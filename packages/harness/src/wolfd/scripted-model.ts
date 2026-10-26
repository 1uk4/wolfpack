/**
 * Test-only scripted model provider for real pi-durable turns (no LLM). Wraps pi-ai's faux provider: pi-durable
 * runs its real generation loop (GenerationTask, tool rounds, hooks) and only the model's replies are canned.
 *
 *   const sm = createScriptedModel([fauxAssistantMessage("pong")]);
 *   startWolf({ ..., models: sm.models })   // tier provider/model = sm.provider / sm.modelId
 */
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { fauxProvider, type FauxProviderHandle, type FauxResponseStep } from "@earendil-works/pi-ai";

export { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";

export const SCRIPTED_PROVIDER = "scripted";
export const SCRIPTED_MODEL = "scripted-1";

export interface ScriptedModel {
  models: Models;
  provider: string;
  modelId: string;
  /** Underlying faux handle: state.callCount, appendResponses, getPendingResponseCount. */
  faux: FauxProviderHandle;
}

/** Responses are consumed in order, one per model request (a tool round is two requests). */
export function createScriptedModel(script: FauxResponseStep[]): ScriptedModel {
  const faux = fauxProvider({ provider: SCRIPTED_PROVIDER, api: SCRIPTED_PROVIDER, models: [{ id: SCRIPTED_MODEL }], tokensPerSecond: undefined });
  faux.setResponses(script);
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, provider: SCRIPTED_PROVIDER, modelId: SCRIPTED_MODEL, faux };
}
