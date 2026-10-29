# Model providers

wolfd and the VPS harness build ONE pi-ai model registry from the providers the configured tiers name.
Each tier in `models.json` carries `{ provider, model }` (`piModel` is `<provider>/<model>`):

```json
{ "tiers": {
    "main":  { "model": "claude-opus-5-5",   "piProvider": "claude-bridge", "piModel": "claude-bridge/claude-opus-5-5" },
    "smart": { "model": "claude-sonnet-5-5", "piProvider": "claude-bridge", "piModel": "claude-bridge/claude-sonnet-5-5" },
    "fast":  { "model": "claude-haiku-5-5",  "piProvider": "anthropic",     "piModel": "anthropic/claude-haiku-5-5" } } }
```

Author it in `~/.wolfpack/config.yaml` (or `wolf.yaml`): `models: { fast: { provider: anthropic, model: claude-haiku-5-5 } }`.
A tier without `provider` takes the legacy `transport` default (`subscription` → claude-bridge, `api` → anthropic), so old
configs and old `models.json` files (no `piProvider`) keep working. Keys come from `~/.wolfpack/.env`.

Only the providers actually named are built: a config with no `claude-bridge` tier never loads the bridge.

## Adding a provider (OpenRouter example)

1. One entry in `providers/index.ts`:

   ```ts
   import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter"; // pi-ai's provider factory
   PROVIDER_FACTORIES.openrouter = () => ({ provider: openrouterProvider() }); // reads OPENROUTER_API_KEY
   ```

   Optional hooks on the handle: `forget(sessionId)` (a conversation ended) and `dispose()` (wolf shutdown).
2. Config: `models: { fast: { provider: openrouter, model: <openrouter model id> } }` and the key in `~/.wolfpack/.env`.

Subagent and memory paths do not require thinking or prompt caching: thinking is only passed when a tier sets it.
