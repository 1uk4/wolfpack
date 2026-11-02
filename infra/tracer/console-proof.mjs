// Browser-driven proof (runs inside the --console container): the standalone console in RELAY mode, a real headless chromium.
//   node console-proof.mjs <console-url> <browser-token> <out-dir> <expected-reply>
// Fails loudly (exit 1 + screenshot <out-dir>/console-proof-FAIL.png). Success prints CONSOLE RELAY PROOF OK from the caller.
import { chromium } from "playwright-core";
const [base, token, out, expect] = process.argv.slice(2);
const step = (m) => console.log(`[console-proof] ${m}`);
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log(`[console-proof] pageerror: ${e.message}`));
const shot = (n) => page.screenshot({ path: `${out}/console-proof-${n}.png`, fullPage: true }).catch(() => {});
try {
  // 1. unpaired browser: relay mode answers 401 + the hub-auth marker (the mock client would answer 200 with fixtures)
  const anon = await ctx.request.get(`${base}/api/wolves`);
  step(`unpaired GET /api/wolves -> ${anon.status()} X-Wolfpack-Hub-Auth=${anon.headers()["x-wolfpack-hub-auth"]}`);
  if (anon.status() !== 401 || anon.headers()["x-wolfpack-hub-auth"] !== "required") throw new Error("expected 401 + X-Wolfpack-Hub-Auth: required without a token (console is not in relay mode?)");
  // 1b. anti-framing headers on every route
  const pairRes = await ctx.request.get(`${base}/pair`);
  step(`/pair headers: CSP=${pairRes.headers()["content-security-policy"]} XFO=${pairRes.headers()["x-frame-options"]}`);
  if (pairRes.headers()["content-security-policy"] !== "frame-ancestors 'none'" || pairRes.headers()["x-frame-options"] !== "DENY") throw new Error("anti-framing headers missing");
  // 1c. a bogus token + cookie (revoked/forged): the server-rendered page fails on the hub 401, the error boundary probes /api, the
  //     fetch wrapper clears token + cookie and lands on /pair
  const host = new URL(base).hostname;
  await ctx.addCookies([{ name: "wolfpack_hub_token", value: "bogus-token-0123456789", domain: host, path: "/" }]);
  await page.goto(`${base}/pair`);
  await page.evaluate(() => localStorage.setItem("wolfpack.hub.token", "bogus-token-0123456789"));
  await page.goto(`${base}/wolf/hal2`);
  await page.waitForURL(/\/pair(\?|#|$)/, { timeout: 20000 });
  await page.getByText("Sign in to the hub").waitFor({ timeout: 10000 });
  const left = (await ctx.cookies()).filter((c) => c.name.includes("wolfpack_hub_token"));
  const tokLeft = await page.evaluate(() => localStorage.getItem("wolfpack.hub.token"));
  step(`bogus token: landed on ${page.url()}, cookies left=${left.length}, localStorage token=${tokLeft}`);
  if (left.length || tokLeft) throw new Error("bogus token/cookie were not cleared");
  await shot("0-bogus-token-to-pair");
  // 2. pair exactly like the hub's /pair page does: land on /pair#token=...
  await page.goto("about:blank"); // a hash-only navigation from /pair would not reload the page
  await page.goto(`${base}/pair#token=${token}`);
  await page.waitForURL(`${base}/`, { timeout: 20000 });
  step("paired: token stored by the console /pair page, redirected home");
  // 3. the wolf list shows hal2, its thread list shows the home thread
  await page.goto(`${base}/wolf/hal2`);
  const link = page.locator('[data-testid="thread-list"] a').first();
  await link.waitFor({ timeout: 30000 });
  step(`hal2 thread list: ${(await page.locator('[data-testid="thread-list"] a').allInnerTexts()).join(" | ").replace(/\s+/g, " ")}`);
  await shot("1-thread-list");
  await link.click();
  const ta = page.locator('[data-testid="composer"] textarea').first();
  await ta.waitFor({ timeout: 30000 });
  // 4. send, see the reply rendered
  await ta.fill("ping");
  await ta.press("Enter");
  step("sent 'ping'; waiting for the reply");
  await page.getByText(expect, { exact: false }).first().waitFor({ timeout: 60000 });
  step(`reply '${expect}' rendered`);
  await shot("2-reply");
  // 5. persisted through the hub: reload shows it again
  await page.reload();
  await page.getByText(expect, { exact: false }).first().waitFor({ timeout: 30000 });
  step("reply still there after reload (history read back through the hub relay)");
  await shot("3-reloaded");
  await browser.close();
} catch (e) {
  console.error(`[console-proof] FAIL: ${e.message}`);
  await shot("FAIL");
  console.error(`[console-proof] url=${page.url()} screenshot=${out}/console-proof-FAIL.png`);
  await browser.close();
  process.exit(1);
}
