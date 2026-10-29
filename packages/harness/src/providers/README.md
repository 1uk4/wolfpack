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

## Rolling out `claude-stateless` (the stateless Claude bridge)

`claude-stateless` (`providers/claude-stateless.ts`) is the same Max-subscription transport as `claude-bridge`, but each
model round is one short-lived Agent SDK query over a resumable session file instead of a parked child. Both stay
installed; `claude-bridge` stays the default. It needs `CLAUDE_CODE_OAUTH_TOKEN` like claude-bridge. State lives under the
wolf den: `<den>/claude-stateless/sessions` (session files, the fixed CLI cwd) and `<den>/claude-stateless/debug.log`
(JSON lines, always on). It reuses claude-bridge's model table (same ids).

> The dependency `pi-claude-bridge-stateless` is a LOCAL path (`file:` clone, branch `stateless-core`). It must become a
> pushed git ref before any VPS deploy.

**Who uses which tier.** Subagents take their tier from the agent profile's `model:` frontmatter, else the `model` argument
of the spawn call, else **`smart`** (`subagents.ts`: `params.model ?? def.model ?? "smart"`). Nothing is subagent-only:
`smart` is also what engine steps (memory, consolidation, KB sweep) and a thread's "smart" tier switch use. Engine steps
reach `claude-stateless` through the `claude-agent-sdk` adapter (the engine maps the id like claude-bridge), so for them
nothing changes. The smallest change is therefore to move **`smart`** only.

**Step 1: subagents on claude-stateless, main stays on claude-bridge** (`~/.wolfpack/config.yaml` or the wolf's
`wolf.yaml`; then restart the wolf so `models.json` is rewritten and the registry rebuilt):

```yaml
models:
  smart: { provider: claude-stateless, model: claude-sonnet-5-5 }
```

Resolved `models.json` tiers: `main` stays `claude-bridge/claude-opus-5-5`, `smart` becomes
`{ "model": "claude-sonnet-5-5", "provider": "claude-agent-sdk", "piProvider": "claude-stateless", "piModel": "claude-stateless/claude-sonnet-5-5" }`.
Agents whose profile says `model: main` or `fast` (or a spawn with `model: "main"`) still run on claude-bridge. The owner can
also pick the smart tier for a thread; that thread then runs stateless too (accepted for the trial). Roll back by deleting the
`smart` line.

**Step 2: threads too** (home and feature threads run on `main`):

```yaml
models:
  main:  { provider: claude-stateless, model: claude-opus-5-5 }
  smart: { provider: claude-stateless, model: claude-sonnet-5-5 }
```

(and `fast` likewise if wanted). A conversation that was stored with a `claude-bridge` ref keeps resolving (lookup-only when
no tier uses it; built when one does). Not applied here.
