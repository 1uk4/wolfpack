/**
 * Wolfpack Browser Extension (pi-durable). A guarded headless Chromium for wolves.
 *
 * OFF by default: with no `browser: { enabled: true }` block in wolf.yaml the extension registers no tools and never
 * touches Playwright. Enabling needs `extensions: [browser]` plus the block (see README.md for the keys).
 * Loading never throws: a bad config yields a tool-less extension, so it cannot stop a wolf from starting.
 */
import { defineExtension, defineTool, Type, type ExtensionContext } from "@wolfpack/harness/extension";
import { BrowserSession, type Tab, type BrowserConfig } from "./session.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (err: unknown) => ({ content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true });

export default function createBrowserExtension(config: BrowserConfig | undefined, context: ExtensionContext): ReturnType<typeof defineExtension> {
  const cfg: BrowserConfig = config && typeof config === "object" ? config : {};
  if (cfg.enabled !== true) return defineExtension({ name: "wolfpack-browser", runtimes: ["pi-durable"] });

  const session = new BrowserSession(context.wolfDen, {
    ...cfg,
    allowHosts: Array.isArray(cfg.allowHosts) ? cfg.allowHosts.filter((h): h is string => typeof h === "string") : [],
  });
  // Each thread (conversation) gets its own tab; a caller without an id uses the "default" tab.
  const tabOf = (tc?: { conversationId?: number }) => {
    const id = tc?.conversationId;
    return session.thread(typeof id === "number" && Number.isFinite(id) ? id : "default");
  };
  // The single exit point: every text a tool returns (results and errors alike) is scrubbed of sign-in secrets.
  const ok = (t: string) => text(session.scrub(t));
  const failed = (err: unknown) => {
    const r = fail(err);
    return { ...r, content: [{ type: "text" as const, text: session.scrub(r.content[0].text) }] };
  };
  const guarded = (fn: (tab: Tab, a: any) => Promise<string>) => async (args: unknown, tc?: { conversationId?: number }) => {
    const tab = tabOf(tc);
    try {
      return ok(await tab.run(() => fn(tab, args ?? {})));
    } catch (err) {
      return failed(err);
    }
  };

  return defineExtension({
    name: "wolfpack-browser",
    runtimes: ["pi-durable"],
    tools: [
      defineTool({
        name: "browser_goto",
        description: "Open an http(s) URL in the wolf's own headless browser (dedicated profile). Loopback, private, tailnet hosts are blocked unless allowlisted.",
        parameters: Type.Object({
          url: Type.String(),
          waitUntil: Type.Optional(Type.Union([Type.Literal("load"), Type.Literal("domcontentloaded"), Type.Literal("networkidle"), Type.Literal("commit")])),
          timeoutMs: Type.Optional(Type.Number()),
        }),
        execute: guarded((tab, a) => tab.goto(String(a.url), a.waitUntil, a.timeoutMs)),
      }),
      defineTool({
        name: "browser_click",
        description: "Click the element matching a Playwright selector on the current page.",
        parameters: Type.Object({ selector: Type.String() }),
        execute: guarded((tab, a) => tab.click(String(a.selector))),
      }),
      defineTool({
        name: "browser_fill",
        description: "Fill an input matching a Playwright selector with a value.",
        parameters: Type.Object({ selector: Type.String(), value: Type.String() }),
        execute: guarded((tab, a) => tab.fill(String(a.selector), String(a.value))),
      }),
      defineTool({
        name: "browser_eval",
        description: "Evaluate a JavaScript expression in the page and return the JSON result (output is capped).",
        parameters: Type.Object({ expression: Type.String() }),
        execute: guarded((tab, a) => tab.evaluate(String(a.expression))),
      }),
      defineTool({
        name: "browser_screenshot",
        description: "Take a PNG screenshot of the page. Returns the file path (deleted when the browser closes); read it with an image-capable tool.",
        parameters: Type.Object({ fullPage: Type.Optional(Type.Boolean()) }),
        execute: guarded(async (tab, a) => `Screenshot saved: ${await tab.screenshot(a.fullPage === true)}`),
      }),
      defineTool({
        name: "browser_console",
        description: "Recent console messages and page errors (newest last).",
        parameters: Type.Object({ limit: Type.Optional(Type.Number()), filter: Type.Optional(Type.String()), clear: Type.Optional(Type.Boolean()) }),
        execute: guarded(async (tab, a) => tab.console(a)),
      }),
      defineTool({
        name: "browser_network",
        description: "Recent network requests as JSON lines. Credential headers (authorization, cookie, set-cookie, …) are redacted.",
        parameters: Type.Object({
          limit: Type.Optional(Type.Number()),
          urlFilter: Type.Optional(Type.String()),
          status: Type.Optional(Type.Number()),
          clear: Type.Optional(Type.Boolean()),
        }),
        execute: guarded(async (tab, a) => tab.network(a)),
      }),
      defineTool({
        name: "browser_close",
        description: "Close this thread's browser tab and delete its screenshots (other threads' tabs stay open; the browser exits with its last tab). The next browser_* call opens a fresh tab.",
        parameters: Type.Object({}),
        // Not queued: it must work even when an earlier call is stuck.
        execute: async (_args: unknown, tc?: { conversationId?: number }) => {
          try {
            await tabOf(tc).closeTab();
            return text("Browser tab closed.");
          } catch (err) {
            return failed(err);
          }
        },
      }),
    ],
    lifecycle: {
      stop: () => session.close(),
    },
  });
}
