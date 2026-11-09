# UI check standard

Applies to every change a user can see in `apps/console`, whoever makes it.
Goal: each thread checks its own worktree in its own browser tab, and never disturbs the owner's preview or another thread.

## 1. When
- Check a visible console change in a browser before you report it done. Typecheck and tests don't show layout.
- Subagents have no browser tools. The thread that owns the work does the check, or the brief says who does.

## 2. Get a slot for your own worktree
- `wolfpack preview slot get <worktree> --json` returns `{url, port, ...}`. `<worktree>` is a name or directory, matched like `wolfpack preview <name>`.
- A slot is a private `next dev` of that worktree's console. Slots use ports 3231 and up, at most 2 at once.
- Running `get` again for the same worktree reuses the slot and keeps it alive. A slot stops by itself after 20 idle minutes.
- The worktree needs `apps/console/node_modules` and built workspace packages, or `get` refuses. Run `pnpm install` / `pnpm build` in the worktree first (nothing is built for you).
- The home checkout is refused: its console already runs on 3230. Use a feature worktree.
- If both slots are taken, `get` refuses and lists them. Wait and retry later. Never release another thread's slot.
- If `get --json` returns `noToken: true`, put the `tokenSetup` lines verbatim in a brief card to the owner. Never ask for a token or code in chat, and never write `~/.wolfpack/preview/hub-token` yourself.

## 3. Check it in your own tab
- `browser_goto <url>`. Each thread has its own tab, so threads don't interfere. On a slot port the browser signs itself in. Never paste, print or ask for tokens.
- Take screenshots with `browser_screenshot` and read `browser_console` for errors. A short burst of 401s just before sign-in completes is expected.
- Check desktop width (the browser's default viewport is 1280x800) and mobile width, 390px.
- For 390px, call `browser_goto` with `width: 390` (height defaults to 844), then `browser_screenshot`. `browser_screenshot` also takes `width`/`height` to resize before shooting. It resizes only your thread's tab and sticks until you change it or call `browser_close`, so pass `width: 1280` to go back to desktop. The result line `Viewport: 390x844` confirms the size.
- Look at the 390px screenshot and confirm the mobile layout shows, not just that the page loaded.

## 4. Report
- Include the screenshots, the slot URL `http://127.0.0.1:<port>`, and the line `wolfpack preview slot pair <port>`. The owner runs it once per port to open the same slot in his own browser.
- Say that the slot idles out after 20 minutes and that `wolfpack preview slot get <worktree>` restarts it.

## 5. Release
- When you're done: `wolfpack preview slot release <port>`. Release only your own slot.

## 6. Never
- Touch port 3230: the owner's preview, a launchd service.
- Run `wolfpack preview off`, `restart` or `switch`, or `launchctl` on preview services.
- Kill next or node processes by name.
- Release or reuse another thread's slot.
- Switch 3230 to your worktree unless the owner explicitly asks to see something there.
- Run `scripts/runtime-preview*.test.ts`, or any test that touches real processes, while the owner's preview runs, unless the test file stubs process lookup and kill.
