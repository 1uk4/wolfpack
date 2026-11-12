/**
 * Packages the runtime bundles import from outside the bundle (work-wolfpack-07v3AmE).
 * build-runtime.mjs marks all of them external; check-app.mjs checks that every one a bundle imports resolves
 * from inside the app's Resources/runtime. `optional` ones are loaded in try/catch or only by features the app does not ship.
 */
export const REQUIRED_EXTERNALS = ["onnxruntime-node", "@huggingface/tokenizers", "@anthropic-ai/claude-agent-sdk"];
// ws native addons (ws falls back to JS) and the Telegram bot (not part of the friend app).
export const OPTIONAL_EXTERNALS = ["bufferutil", "utf-8-validate", "grammy"];
export const EXTERNALS = [...OPTIONAL_EXTERNALS, ...REQUIRED_EXTERNALS];
