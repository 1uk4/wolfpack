# Attach your Claude subscription to Wolfpack

**For the human.** This makes the wolf's chat and memory run on your Claude subscription (Pro/Max) instead of an API key.
- It uses Anthropic's Agent SDK through the `claude-subscription` plug-in and your own Claude Code install.
- KB curation (hubd) still needs an API key: it keeps its own `models.curator.json` on the key.
- The token from `claude setup-token` lasts about a year. Tell Claude Code to run this file; it asks you for two things (the browser sign-in, one paste).
- Undo: step 7.

**For Claude Code.** Run each step in order, in one shell session (variables carry over). Never print the token. Do each "Stop if" check.

## 1. Find the app's folder, quit the app
```bash
H="${WOLFPACK_APP_HOME:-$HOME/Library/Application Support/Wolfpack Console}"
osascript -e 'quit app "Wolfpack Console"'; sleep 3
test -f "$H/setup.json" && echo "ok: $H"
```
Stop if: `ok:` is not printed. Say "open Wolfpack once and finish setup", then end.

## 2. Install the plug-in
```bash
mkdir -p "$H/plugins"; D="$(mktemp -d)"; cd "$D"
U=https://github.com/1uk4/wolfpack/releases/download/plugin-claude-subscription
curl -fsSLO "$U/claude-subscription-latest.tgz" && curl -fsSLO "$U/claude-subscription-latest.tgz.sha256"
shasum -a 256 -c claude-subscription-latest.tgz.sha256
rm -rf "$H/plugins/claude-subscription"
tar -xzf claude-subscription-latest.tgz -C "$H/plugins"
test -f "$H/plugins/claude-subscription/package.json" && echo installed
```
Stop if: a download fails, `shasum` does not say `OK`, or `installed` is missing. Do not run npm/pnpm inside the folder (it carries its own node_modules).

## 3. Find Claude Code
```bash
P="$(command -v claude)"; test -n "$P" && P="$(readlink -f "$P")"; echo "claude: $P"
N=""; if [ "$(head -c 2 "$P")" = "#!" ] && head -n 1 "$P" | grep -q node; then N="$(command -v node)"; fi
echo "node: ${N:-not needed}"
```
Stop if: `P` is empty. Say "install Claude Code first". Stop if `N` is needed but empty (Claude Code is a node script and no `node` is on PATH).

## 4. Token and paths into keys.env
Ask the human to run `claude setup-token` in a terminal (it opens the browser; they sign in) and to paste the printed token when you run the next block. Do not capture or echo it.
```bash
read -rs -p "Paste token: " T; echo
printf '%s' "$T" | grep -Eq '^[!-~]+$' && ! printf '%s' "$T" | grep -q "[\"'\\\$#]" && echo "token ok" || echo "token has characters keys.env cannot hold"
```
Stop if: not `token ok`. Then:
```bash
umask 077; K="$H/keys.env"; touch "$K"
grep -Ev '^(CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_PATH|CLAUDE_CODE_NODE)=' "$K" > "$K.new" || true
{ echo "CLAUDE_CODE_OAUTH_TOKEN=$T"; echo "CLAUDE_CODE_PATH=$P"; [ -n "$N" ] && echo "CLAUDE_CODE_NODE=$N"; } >> "$K.new"
mv "$K.new" "$K"; chmod 600 "$K"; unset T
grep -c '^CLAUDE_CODE_' "$K"
```
Line format is `NAME=value`, one per line, no quotes, mode 0600. Stop if: the count is not 2 (or 3 with `N`).

## 5. Config: wolf.yaml and models.json
The wolf folder is `~/Wolves/<id>` (or `$WOLFPACK_APP_WOLVES/<id>`); `<id>` is `.wolf` in `$H/setup.json`.
```bash
W="${WOLFPACK_APP_WOLVES:-$HOME/Wolves}/$(sed -n 's/.*"wolf" *: *"\([^"]*\)".*/\1/p' "$H/setup.json" | head -1)"
cp "$W/wolf.yaml" "$W/wolf.yaml.bak-attach"; cp "$W/models.json" "$W/models.json.bak-attach"
grep -q '^plugins:' "$W/wolf.yaml" && echo "plugins already set" || printf 'plugins: [claude-subscription]\n' >> "$W/wolf.yaml"
cat "$W/models.json"
```
Stop if: `$W/wolf.yaml` or `models.json` is missing, or `plugins already set` is printed (read the line, ask the human).

Now edit `$W/models.json` with your edit tool, keeping everything else: set top-level `"transport": "subscription"`; in each of `tiers.main`, `tiers.smart`, `tiers.fast` set `"provider": "claude-subscription"` and `"piModel": "claude-subscription/<that tier's model>"` (the `model` value, unchanged). Do not touch `models.curator.json`.
Stop if: the JSON no longer parses (`plutil -convert json -o /dev/null "$W/models.json"` prints an error; `-lint` does not read JSON).

## 6. Reopen and verify
```bash
open -a "Wolfpack Console"; sleep 25
tail -n 60 "$HOME/Library/Application Support/Wolfpack Console/logs/main.log" | grep -iE "harness\] Models|plugin|error"
```
Expect `[harness] Models: main=<model> smart=… fast=… (transport subscription)` and no `plugin` error line. (Startup stops with a message naming the plug-in if the plug-in or a variable is missing.) Then ask the human to send "hello" in the console and expect a reply.
Stop if: a plug-in error appears or there is no reply. Go to step 7 and report the error line.

## 7. Rollback
```bash
osascript -e 'quit app "Wolfpack Console"'; sleep 3
mv "$W/wolf.yaml.bak-attach" "$W/wolf.yaml"; mv "$W/models.json.bak-attach" "$W/models.json"
grep -Ev '^CLAUDE_CODE_(OAUTH_TOKEN|PATH|NODE)=' "$H/keys.env" > "$H/keys.env.new"; mv "$H/keys.env.new" "$H/keys.env"; chmod 600 "$H/keys.env"
open -a "Wolfpack Console"
```
