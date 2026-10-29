# Model providers

wolfd and the VPS harness build ONE pi-ai model registry from the providers the configured tiers name.
Each tier in `models.json` carries `{ provider, model }` (`piModel` is `<provider>/<model>`):

```json
{ "tiers": {
    "main":  { "model": "claude-opus-5-5",   "piProvider": "claude-bridge", "piModel": "claude-bridge/claude-opus-5-5" },
    "smart": { "model": "claude-sonnet-5-5", "piProvider": "claude-bridge", "piModel": "claude-bridge/claude-sonnet-5-5" },
    "fast":  { "model": "claude-haiku-5-5",  "piProvider": "anthropic",     "piModel": "anthropic/claude-haiku-5-5" } } }
```

Naming: in config INPUT (`config.yaml` / `wolf.yaml` `models.<tier>.provider`) `provider` is the pi provider. In the resolved
`models.json`, `provider` is the ENGINE provider (`claude-bridge` → `claude-agent-sdk`) and `piProvider` is the pi provider.

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
   Requires a pi-ai provider module: pi-ai 1.4.0 ships `providers/openrouter` (checked in node_modules), so that import
   exists; other providers need their own module.
2. Config: `models: { main: { provider: openrouter, model: <openrouter model id> } }` and the key in `~/.wolfpack/.env`.

This is one map entry plus config for the main and subagent (pi-durable) paths. Engine steps (memory, consolidation,
KB sweep, librarian) read `smart` / `fast` through the engine adapters, which exist only for anthropic and
claude-bridge: `resolveModelTable` refuses any other provider on those two tiers, so only `main` can use a new provider today.

A den may hold stored model refs to providers a wolf no longer uses; those register lookup-only (resolvable, never served).

Subagent and memory paths do not require thinking or prompt caching: thinking is only passed when a tier sets it.
