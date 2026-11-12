/**
 * Packages the runtime bundles import from outside the bundle (work-wolfpack-07v3AmE).
 * build-runtime.mjs marks all of them external; check-app.mjs checks that every one a bundle imports resolves
 * from inside the app's Resources/runtime. `optional` ones are loaded in try/catch or only by features the app does not ship.
 */
export const REQUIRED_EXTERNALS = ["onnxruntime-node", "@huggingface/tokenizers"];
// ws native addons (ws falls back to JS), the Telegram bot (not part of the friend app), and the Agent SDK: the app is
// API-key only and does not ship it (the engine imports it lazily, only for the subscription adapter).
export const OPTIONAL_EXTERNALS = ["bufferutil", "utf-8-validate", "grammy", "@anthropic-ai/claude-agent-sdk"];
export const EXTERNALS = [...OPTIONAL_EXTERNALS, ...REQUIRED_EXTERNALS];
