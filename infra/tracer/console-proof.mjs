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
  await mobilePass();
  await browser.close();
} catch (e) {
  console.error(`[console-proof] FAIL: ${e.message}`);
  await shot("FAIL");
  console.error(`[console-proof] url=${page.url()} screenshot=${out}/console-proof-FAIL.png`);
  await browser.close();
  process.exit(1);
}

// ---- MOBILE PASS (P3): iPhone-sized touch viewport. Kept as one function so it merges cleanly with other edits to this file. ----
async function mobilePass() {
  const mstep = (m) => console.log(`[console-proof:mobile] ${m}`);
  const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: UA });
  const mp = await mctx.newPage();
  const extra = []; // contexts opened only for the manifest probe; closed in finally
  const VW = 390; // the emulated viewport width; overflow is checked against this constant, not window.innerWidth (which a wide layout can inflate)
  mp.on("pageerror", (e) => console.log(`[console-proof:mobile] pageerror: ${e.message}`));
  const mshot = (n) => mp.screenshot({ path: `${out}/console-mobile-${n}.png` }).catch(() => {});
  const noOverflow = async (where) => {
    const w = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, iw: window.innerWidth }));
    mstep(`${where}: scrollWidth=${w.sw} body=${w.bw} innerWidth=${w.iw} (limit ${VW})`);
    if (w.sw > VW || w.bw > VW || w.iw !== VW) { await mshot(`overflow-${where.replace(/\W+/g, "-")}`); throw new Error(`horizontal overflow at ${where}: ${w.sw}/${w.bw}/inner ${w.iw} vs ${VW}`); }
  };
  try {
    // manifest: public (no cookie), valid, installable fields, icons fetchable
    const bctx = await browser.newContext();
    extra.push(bctx);
    const bare = await bctx.request.get(`${base}/manifest.webmanifest`);
    if (bare.status() !== 200) throw new Error(`manifest status ${bare.status()}`);
    const m = await bare.json();
    mstep(`manifest: ${m.name}/${m.short_name} display=${m.display} start_url=${m.start_url} theme=${m.theme_color} icons=${m.icons?.length}`);
    if (!m.name || !m.short_name || m.display !== "standalone" || m.start_url !== "/" || !m.theme_color || !m.background_color) throw new Error("manifest missing required fields");
    if (!m.icons?.some((i) => i.sizes === "192x192") || !m.icons?.some((i) => i.sizes === "512x512")) throw new Error("manifest needs 192 and 512 icons");
    for (const i of m.icons) {
      const r = await mctx.request.get(new URL(i.src, base).href);
      if (r.status() !== 200 || !(r.headers()["content-type"] ?? "").includes("image/png")) throw new Error(`icon ${i.src} -> ${r.status()} ${r.headers()["content-type"]}`);
    }
    // pair, then the home screen on a phone is the LIST layer
    await mp.goto(`${base}/pair#token=${token}`);
    await mp.waitForURL(`${base}/`, { timeout: 20000 });
    const link = await mp.locator('link[rel="manifest"]').getAttribute("href");
    if (!link) throw new Error("page has no <link rel=manifest>");
    await mp.locator('[data-testid="sidebar"][data-mobile-list]').waitFor({ timeout: 20000 });
    mstep("home on a phone = the full-screen list layer");
    await noOverflow("list");
    await mshot("1-list");
    // open hal2: the wolf list page (thread links), tap = touch
    await mp.goto(`${base}/wolf/hal2`);
    if (await mp.locator('[data-testid="sidebar"][data-mobile-list]').count()) throw new Error("deep link to /wolf/hal2 still shows the list layer");
    const tl = mp.locator('[data-testid="thread-list"] a').first();
    await tl.waitFor({ timeout: 30000 });
    await noOverflow("wolf list");
    await mshot("2-wolf-hal2");
    await tl.tap();
    const ta = mp.locator('[data-testid="composer"] textarea').first();
    await ta.waitFor({ timeout: 30000 });
    // tap targets >= 44px in the composer
    const small = await mp.evaluate(() => [...document.querySelectorAll('[data-testid="composer"] button, [data-testid="composer"] textarea')].filter((e) => { const st = getComputedStyle(e); const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden" && !e.closest("[hidden],[aria-hidden=true],.hidden"); }).map((e) => e.getBoundingClientRect()).filter((r) => r.width < 43.5 || r.height < 43.5).length);
    if (small) throw new Error(`${small} composer control(s) under 44px`);
    await ta.tap();
    // a unique nonce, and a NEW reply after it: old history (earlier runs, the desktop pass) must not satisfy this
    const nonce = `ping-${Math.random().toString(36).slice(2, 10)}`;
    const countReplies = () => mp.evaluate((t) => document.body.innerText.split(t).length - 1, expect);
    const before = await countReplies();
    await ta.fill(nonce);
    await mshot("3-composing");
    await mp.locator('[data-testid="composer"] button[type="submit"]').tap();
    await mp.getByText(nonce, { exact: false }).first().waitFor({ timeout: 30000 });
    await mp.waitForFunction(([t, n]) => document.body.innerText.split(t).length - 1 > n, [expect, before], { timeout: 60000 });
    const order = await mp.evaluate(([t, nc]) => { const x = document.body.innerText; return x.lastIndexOf(t) > x.lastIndexOf(nc); }, [expect, nonce]);
    if (!order) throw new Error("the reply does not follow the nonce message");
    mstep(`nonce ${nonce} sent; reply '${expect}' count ${before} -> ${await countReplies()}, after the nonce`);
    await noOverflow("thread");
    await mshot("4-reply");
    // back = the visible back control returns to the list layer
    await mp.locator('[data-testid="mobile-back"]').tap();
    await mp.locator('[data-testid="sidebar"][data-mobile-list]').waitFor({ timeout: 10000 });
    await noOverflow("list after back");
    await mshot("5-back");
    mstep("MOBILE PASS OK");
  } catch (e) {
    await mshot("FAIL");
    throw new Error(`mobile pass: ${e.message}`);
  } finally {
    for (const c of [...extra, mctx]) await c.close().catch(() => {});
  }
}
