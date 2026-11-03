// Browser-driven proof (runs inside the --console container): the standalone console in RELAY mode, a real headless chromium.
//   node console-proof.mjs <console-url> <hub-pair-link> <out-dir> <expected-reply>
// The pair link is what `hubd pair --kind browser` prints (QR target): the hub's /pair page with a one-time code. The page redirects to <console>/pair#token=...
// After the proof the entrypoint revokes the device (/tmp/proof-want-revoke -> hubd tokens revoke -> /tmp/proof-revoked) and the console must send the browser back to /pair.
// Fails loudly (exit 1 + screenshot <out-dir>/console-proof-FAIL.png). Success prints CONSOLE RELAY PROOF OK from the caller.
import { chromium } from "playwright-core";
const [base, pairLink, out, expect] = process.argv.slice(2);
let token; // device token from pairing via the QR link; the mobile pass reuses it, so it must run before the revoke step
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
  // 2. pair through the QR link: the hub's /pair page (code prefilled from ?code=), submit, the hub redirects to <console>/pair#token=...
  await page.goto("about:blank");
  await page.goto(pairLink);
  await page.locator("#code").waitFor({ timeout: 10000 });
  if (!(await page.locator("#code").inputValue())) throw new Error("the QR link did not prefill the pairing code");
  await page.getByRole("button", { name: "Pair" }).click();
  await page.waitForURL(`${base}/`, { timeout: 20000 });
  step("paired through the hub /pair page (QR link): token stored by the console /pair page, redirected home");
  const stored = await page.evaluate(() => localStorage.getItem("wolfpack.hub.token"));
  token = stored;
  if (!stored) throw new Error("the browser did not store a token");
  if (page.url().includes("token=")) throw new Error("token left in the URL");
  // the QR code is single-use: a second visit to the same link cannot pair
  const again = await ctx.newPage();
  await again.goto(pairLink);
  await again.getByRole("button", { name: "Pair" }).click();
  await again.getByText("already used or expired").waitFor({ timeout: 10000 });
  step("the same QR link a second time: refused (single use)");
  await again.close();
  // 3. the wolf list shows hal2, its thread list shows the home thread
  await page.goto(`${base}/wolf/hal2`);
  const link = page.locator('[data-testid="thread-list"] a').first();
  await link.waitFor({ timeout: 30000 });
  step(`hal2 thread list: ${(await page.locator('[data-testid="thread-list"] a').allInnerTexts()).join(" | ").replace(/\s+/g, " ")}`);
  await shot("1-thread-list");
  // 3b. P7: the KB graph in relay mode. hubd carries the worker-reported flags in /v1/wolves; the console finds a KB source; the wolf-scoped graph route tunnels to hal2.
  const auth = { Authorization: `Bearer ${token}` };
  const wl = await (await ctx.request.get(`${base}/api/wolves`, { headers: auth })).json();
  const hal = (wl.wolves ?? wl).find?.((w) => w.name === "hal2");
  step(`hal2 flags via console: librarian=${hal?.librarian} kbReadable=${hal?.kbReadable} status=${hal?.status}`);
  if (!hal || hal.kbReadable !== true || hal.status === "offline") throw new Error("hal2 is not reported kbReadable through hubd (flags missing from /v1/wolves in relay mode)");
  const gr = await ctx.request.get(`${base}/api/wolves/hal2/kb/graph`, { headers: auth });
  const gj = await gr.json().catch(() => ({}));
  step(`GET /api/wolves/hal2/kb/graph -> ${gr.status()} nodes=${Array.isArray(gj.nodes) ? gj.nodes.length : "n/a"}`);
  if (gr.status() !== 200 || !Array.isArray(gj.nodes)) throw new Error(`kb/graph through the relay console failed: ${gr.status()} ${JSON.stringify(gj).slice(0, 200)}`);
  // 3c. P9: the graph comes from the HUB's own KB copy (token-scoped), with no KB wolf: the console route answers with every domain the hub holds.
  const hg = await ctx.request.get(`${base}/api/kb/graph`, { headers: auth });
  const hj = await hg.json().catch(() => ({}));
  const doms = (hj.domains ?? []).map((d) => d.name);
  step(`GET /api/kb/graph (hub KB copy) -> ${hg.status()} domains=[${doms.join(",")}] nodes=${Array.isArray(hj.nodes) ? hj.nodes.length : "n/a"} domNodes=${(hj.nodes ?? []).filter((n) => n.kind === "domain").length}`);
  if (hg.status() !== 200 || !Array.isArray(hj.nodes) || hj.nodes.length === 0) throw new Error(`hub kb graph failed: ${hg.status()} ${JSON.stringify(hj).slice(0, 200)}`);
  if (doms.length < 2 || !doms.includes("gphalpha") || !doms.includes("gphbeta")) throw new Error(`hub kb graph shows ${doms.length} domain(s), want >1 incl. gphalpha+gphbeta`);
  if (hj.nodes.filter((n) => n.kind === "domain").length < 2) throw new Error("hub kb graph has fewer than 2 domain nodes");
  const er = await ctx.request.get(`${base}/api/kb/entries/kb-gphbeta-aaaaaaa`, { headers: auth });
  const ej = await er.json().catch(() => ({}));
  step(`GET /api/kb/entries/kb-gphbeta-aaaaaaa (domain hal2 is not subscribed to) -> ${er.status()} domain=${ej.domain} title=${ej.title}`);
  if (er.status() !== 200 || ej.domain !== "gphbeta" || !String(ej.body ?? "").includes("Seed entry of gphbeta")) throw new Error(`hub kb entry failed: ${er.status()} ${JSON.stringify(ej).slice(0, 200)}`);
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
  // 5b. trailing slash: the hub pairing page opened as /pair/?code=... (a proxy or a QR scanner may add the slash) must pair too
  if (process.env.PAIR_LINK_SLASH) {
    const sctx = await browser.newContext();
    const sp = await sctx.newPage();
    await sp.goto(process.env.PAIR_LINK_SLASH);
    if (!(await sp.locator("#code").inputValue())) throw new Error("trailing-slash link did not prefill the code");
    await sp.getByRole("button", { name: "Pair" }).click();
    await sp.waitForURL(`${base}/`, { timeout: 20000 });
    if (!(await sp.evaluate(() => localStorage.getItem("wolfpack.hub.token")))) throw new Error("trailing-slash pairing stored no token");
    step(`TRAILING-SLASH PAIR OK: ${process.env.PAIR_LINK_SLASH.replace(/code=.*/, "code=<redacted>")} paired`);
    await sctx.close();
  }
  await mobilePass();
  await devicesPass();
  // 6. revoke: the entrypoint runs `hubd tokens revoke` while we wait; the console must then send the browser back to /pair
  await import("node:fs").then((fs) => fs.writeFileSync("/tmp/proof-want-revoke", "1"));
  step("waiting for the device to be revoked on the hub");
  for (let i = 0; i < 120 && !(await import("node:fs")).existsSync("/tmp/proof-revoked"); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await import("node:fs")).existsSync("/tmp/proof-revoked")) throw new Error("the revoke signal never came");
  const after = await ctx.request.get(`${base}/api/wolves`, { headers: { Authorization: `Bearer ${stored}` } });
  step(`revoked token GET /api/wolves -> ${after.status()}`);
  if (after.status() !== 401) throw new Error("a revoked token still works through the console");
  await page.goto(`${base}/wolf/hal2`);
  await page.waitForURL(/\/pair(\?|#|$)/, { timeout: 20000 });
  await page.getByText("Sign in to the hub").waitFor({ timeout: 10000 });
  step(`after revoke the console sent the browser to ${page.url()}`);
  await shot("4-revoked-to-pair");
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
    const small = await mp.evaluate(() => [...document.querySelectorAll('[data-testid="composer"] > button, [data-testid="composer"] textarea')].filter((e) => { const st = getComputedStyle(e); const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden" && !e.closest("[hidden],[aria-hidden=true],.hidden"); }).map((e) => e.getBoundingClientRect()).filter((r) => r.width < 43.5 || r.height < 43.5).length);
    if (small) throw new Error(`${small} composer control(s) under 44px`);
    // P10: the per-thread controls are compact by design: the model picker is >= 32px, the Auto-ship switch's tap area is its 44px label
    const ctl = await mp.evaluate(() => ({ tier: document.querySelector('[data-testid="tier-trigger"]')?.getBoundingClientRect().height ?? 99, label: document.querySelector('[data-testid="composer-controls"] label')?.getBoundingClientRect().height ?? 99 }));
    if (ctl.tier < 31.5 || ctl.tier > 40 || ctl.label < 43.5) throw new Error(`composer controls sized wrong: ${JSON.stringify(ctl)}`);
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
    // P12: the document must not scroll (iOS would rubber-band it), and the composer must sit on the viewport bottom
    const pin = await mp.evaluate(() => {
      const se = document.scrollingElement; const c = document.querySelector('[data-testid="composer"]')?.getBoundingClientRect();
      const log = document.querySelector('[data-testid="thread-chat"] [role="log"] > div');
      return { sh: se.scrollHeight, ih: window.innerHeight, bottom: c ? c.bottom : -1, logScrolls: log ? log.scrollHeight >= log.clientHeight : false, ov: getComputedStyle(document.body).overflow };
    });
    mstep(`pinned composer: scrollHeight=${pin.sh} innerHeight=${pin.ih} composerBottom=${pin.bottom} body.overflow=${pin.ov}`);
    if (pin.sh > pin.ih) throw new Error(`document scrolls on a thread page: ${pin.sh} > ${pin.ih}`);
    if (pin.bottom > pin.ih + 0.5 || pin.bottom < pin.ih - 40) throw new Error(`composer not pinned to the bottom: ${pin.bottom} vs ${pin.ih}`);
    if (!pin.logScrolls) throw new Error("message list is not a scroll container");
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

// ---- DEVICES PASS (P4): two devices, list, revoke one, its next request is 401, the other still works. Runs before the entrypoint's own revoke. ----
async function devicesPass() {
  const dstep = (m) => console.log(`[console-proof:devices] ${m}`);
  const hubBase = pairLink.slice(0, pairLink.lastIndexOf("/pair")); // the hub (with its public prefix) the QR link points at
  const as = (t) => ({ Authorization: `Bearer ${t}` });
  try {
    // device B: a code minted through the console by device A (the paired browser), redeemed at the hub like a second phone would
    const mint = await ctx.request.post(`${base}/api/devices/pairing-code`, { headers: { ...as(token), "content-type": "application/json" }, data: { label: "proof-second-device" } });
    if (mint.status() !== 200) throw new Error(`mint pairing code -> ${mint.status()}`);
    const { code } = await mint.json();
    const paired = await ctx.request.post(`${hubBase}/v1/pair`, { headers: { "content-type": "application/json" }, data: { code, label: "proof-second-device" } });
    if (paired.status() !== 200) throw new Error(`redeem at ${hubBase}/v1/pair -> ${paired.status()}`);
    const b = await paired.json();
    dstep(`paired a second device ${b.tokenId}`);
    // list through the console as A: both devices, A marked self, no secrets
    const listRes = await ctx.request.get(`${base}/api/devices`, { headers: as(token) });
    const text = await listRes.text();
    if (listRes.status() !== 200) throw new Error(`list -> ${listRes.status()}`);
    if (text.includes(token) || text.includes(b.token) || /hash/i.test(text)) throw new Error("the device list leaks a secret");
    const devices = JSON.parse(text).devices;
    const me = devices.find((d) => d.self);
    const other = devices.find((d) => d.id === b.tokenId);
    if (!me || !other || other.self) throw new Error(`list shape wrong: ${text}`);
    dstep(`list: ${devices.map((d) => `${d.label}${d.self ? " (this device)" : ""}`).join(", ")}`);
    // B works, then A revokes B
    const okB = await ctx.request.get(`${base}/api/wolves`, { headers: as(b.token) });
    if (okB.status() !== 200) throw new Error(`device B before revoke -> ${okB.status()}`);
    const rev = await ctx.request.delete(`${base}/api/devices/${encodeURIComponent(b.tokenId)}`, { headers: as(token) });
    if (rev.status() !== 200) throw new Error(`revoke B -> ${rev.status()}`);
    const afterB = await ctx.request.get(`${base}/api/wolves`, { headers: as(b.token) });
    const afterA = await ctx.request.get(`${base}/api/wolves`, { headers: as(token) });
    dstep(`after revoking B: B -> ${afterB.status()}, A -> ${afterA.status()}`);
    if (afterB.status() !== 401) throw new Error("revoked device B still works");
    if (afterA.status() !== 200) throw new Error("device A broke when B was revoked");
    dstep("DEVICES PASS OK");
  } catch (e) {
    throw new Error(`devices pass: ${e.message}`);
  }
}
