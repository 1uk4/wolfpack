# claude-subscription: a Wolfpack provider plug-in

Attaches your Claude subscription (Pro/Max) to Wolfpack as the provider `claude-subscription`. It runs **your own installed
Claude Code**, so the download stays small. This package is also the template for your own provider plug-in.

## What a plug-in is

A folder `<plugins dir>/<id>/` with a `package.json` carrying a `wolfpack` field, and a built ESM entry file. Wolfpack loads it
only when wolf.yaml lists it (`plugins: [claude-subscription]`); a folder alone never runs code. It runs inside the wolf's
process, so install only plug-ins you trust.

## Manifest fields

```json
{ "wolfpack": { "apiVersion": 1, "entry": "./dist/index.js",
  "requiredEnv": ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_PATH", "WOLF_DEN"], "optionalEnv": ["CLAUDE_CODE_NODE"],
  "providers": ["claude-subscription"], "engineProviders": ["claude-subscription"] } }
```

- `apiVersion`: must be `1`.  `entry`: the built file, inside the folder.
- `requiredEnv`: variables that must be set, or startup stops naming the plug-in. `optionalEnv`: passed only when set.
  Your code sees only these names in `ctx.env`.
- `providers`: chat provider ids you register. `engineProviders`: engine (memory/consolidation) adapter ids. Ids must not clash
  with built-ins.

## Make your own

1. Copy this folder, change the id, and write `src/index.ts`: default-export
   `{ apiVersion: 1, createProvider(ctx), createEngineAdapter({ env, config }), models(ctx) }` (types `PluginModule` in `@wolfpack/harness`).
2. Bundle it to `dist/index.js` (ESM, node22) and keep big dependencies external.
3. `node scripts/pack.mjs` makes `dist/<id>-<version>.tgz` with a `.sha256`; it extracts to one folder named after the id.
4. Unpack it into the plug-ins dir, set the env variables, enable it in wolf.yaml, restart.

## This plug-in's settings

- `CLAUDE_CODE_OAUTH_TOKEN`: from `claude setup-token`.
- `CLAUDE_CODE_PATH`: absolute path of your `claude` (`which claude`).
- `CLAUDE_CODE_NODE`: only if that `claude` is the npm JavaScript launcher: the absolute path of the `node` that runs it.
