/**
 * The hub's browser pairing page: one static HTML document with inline CSS/JS (no framework, no CDN; the CSP in server.ts allows only
 * inline script/style and same-origin fetch). Flow: code (prefilled from ?code=) + label -> POST /v1/pair {kind:"browser"} -> token.
 * With a console URL configured the token travels to the console in the URL FRAGMENT (`<console>/pair#token=...`): a fragment is never
 * sent to any server or logged, works across origins, and the console's /pair page stores it in localStorage and strips it from the URL.
 * The POST path is derived from the page's own path (`/hub/pair` and `/hub/pair/` both post to `/hub/v1/pair`), so the page works behind a reverse proxy that strips a prefix.
 * Without one, the token is saved in this origin's localStorage ("wolfpack.hub.token") and a message says so.
 */

/**
 * Validate and normalise the console URL (operator config): it must parse, use http: or https:, and is reduced to origin + pathname
 * (no credentials, query or fragment; no trailing slash). Throws otherwise, so a bad value fails at startup, not in a visitor's browser.
 */
export function normalizeConsoleUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error(`console URL is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`console URL must be http: or https: (got ${u.protocol})`);
  return (u.origin + u.pathname).replace(/\/+$/, "");
}

/** `consoleUrl` is operator config (flag/env), embedded as a JSON string literal with `<`, U+2028 and U+2029 escaped (it cannot close the script tag or break the literal). */
export function pairPageHtml(consoleUrl?: string): string {
  const cfg = JSON.stringify({ consoleUrl: consoleUrl ?? null }).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair this browser</title>
<style>body{font:16px system-ui,sans-serif;background:#111;color:#eee;max-width:26rem;margin:3rem auto;padding:0 1rem}
input,button{font:inherit;width:100%;box-sizing:border-box;padding:.6rem;margin:.3rem 0 1rem;border-radius:6px;border:1px solid #555;background:#1c1c1c;color:#eee}
button{background:#2a6;border:0;cursor:pointer}#msg{min-height:1.5rem}.err{color:#f77}.ok{color:#7d7}</style></head>
<body><h1>Pair this browser</h1>
<p>Run <code>hubd pair --kind browser</code> on the hub and enter the code (or scan its QR code).</p>
<form id="f"><label>Pairing code<input id="code" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
<label>Device label<input id="label" maxlength="64" required></label>
<button type="submit">Pair</button></form><p id="msg" role="status"></p>
<script>
(function(){
var CFG=${cfg};
var $=function(i){return document.getElementById(i)};
var msg=function(t,c){var m=$("msg");m.textContent=t;m.className=c||""};
var q=new URLSearchParams(location.search).get("code");
if(q)$("code").value=q;
var ua=navigator.userAgent||"browser";
$("label").value=("Browser: "+ua.replace(/^Mozilla\\/5\\.0 /,"")).slice(0,64);
if(q)history.replaceState(null,"",location.pathname);
$("f").addEventListener("submit",function(e){
e.preventDefault();
msg("Pairing...");
fetch(location.pathname.replace(/\\/pair\\/?$/,"/v1/pair"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:$("code").value.trim(),label:$("label").value.trim().slice(0,64),kind:"browser"})})
.then(function(r){return r.json().catch(function(){return{}}).then(function(b){return{s:r.status,b:b}})})
.then(function(x){
if(x.s===200&&x.b.token){
if(CFG.consoleUrl){
msg("Paired. Opening the console...","ok");
location.replace(CFG.consoleUrl.replace(/\\/+$/,"")+"/pair#token="+encodeURIComponent(x.b.token));
}else{
try{localStorage.setItem("wolfpack.hub.token",x.b.token)}catch(_){}
msg("Paired. The token is saved in this browser.","ok");
}
return}
if(x.s===401)msg("That code is wrong, already used or expired. Run hubd pair again.","err");
else if(x.s===409)msg("The hub is busy. Try again in a moment.","err");
else if(x.s===429)msg("Too many failed attempts. Wait a minute and try again.","err");
else if(x.s===400)msg("The code or label was not accepted: "+(x.b.message||"invalid request"),"err");
else msg("Pairing failed (HTTP "+x.s+").","err");
}).catch(function(){msg("Could not reach the hub.","err")});
});
})();
</script></body></html>
`;
}
