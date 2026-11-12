// Fake wolfd for workerd tests: `node fake-wolf.mjs --config <wolf.yaml> --port N`. No engine, no model.
import { createServer } from "node:http";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (k) => args[args.indexOf(k) + 1];
const name = /^name:\s*(\S+)/m.exec(readFileSync(arg("--config"), "utf8"))[1];
if (process.env.FAKE_EXIT_IMMEDIATELY) process.exit(3);
// Test hook: write the named env variable's value to a file, so a test can see what a child was spawned with.
if (process.env.FAKE_DUMP_ENV_FILE) writeFileSync(process.env.FAKE_DUMP_ENV_FILE, process.env[process.env.FAKE_DUMP_ENV_NAME] ?? "<unset>");

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

let openStreams = 0;
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  if (p === "/crash") process.exit(1);
  if (p === "/v1/wolves") return json(res, 200, { wolves: [{ id: name, name, host: "fake", status: process.env.FAKE_STATUS ?? "online", librarian: name === "beta", ...(name === "alpha" ? { kbReadable: true } : {}) }] });
  // read-only memory / work resources: echo what was asked so the proxy test can see them forwarded unchanged
  if (p === `/v1/wolves/${name}/memory` && url.searchParams.has("openStreams")) return json(res, 200, { openStreams });
  if (p === `/v1/wolves/${name}/memory` && url.searchParams.has("big")) {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    openStreams += 1;
    res.on("close", () => (openStreams -= 1));
    return res.end(Buffer.alloc(Number(url.searchParams.get("big")), 97));
  }
  if (p === `/v1/wolves/${name}/memory` && url.searchParams.has("cookies")) {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": ["a=1", "b=2"], "access-control-allow-origin": "*", "x-keep": "1" });
    return res.end("{}");
  }
  if (p === `/v1/wolves/${name}/memory` && url.searchParams.has("hang")) return; // never answers
  // settings: the masked view (the real wolfd never returns a secret here) and a POST reveal that echoes the asked name
  if (p === `/v1/wolves/${name}/settings` && req.method === "GET")
    return json(res, 200, { etag: "e0", config: { name, memory: { hubToken: { set: true } } }, editable: [], tierModels: {}, env: [{ name: "WORK_TOKEN", set: true, secret: true, purpose: "Work API token" }], restartNeeded: false, restartable: false, restartAvailableInSeconds: 0 });
  if (p === `/v1/wolves/${name}/settings/reveal` && req.method === "POST") {
    const bufs = [];
    req.on("data", (c) => bufs.push(c));
    return req.on("end", () => json(res, 200, { name: JSON.parse(Buffer.concat(bufs).toString("utf8")).name, value: "revealed" }));
  }
  // prompt overrides: reflect the If-Match header and the body back as the prompt view; "stale" is the conflict case
  if (p === `/v1/wolves/${name}/prompts/orchestrator-rules` && (req.method === "PUT" || req.method === "DELETE")) {
    const bufs = [];
    req.on("data", (c) => bufs.push(c));
    return req.on("end", () => {
      const ifMatch = req.headers["if-match"] ?? "";
      if (ifMatch === "stale") return json(res, 409, { code: "conflict", message: "changed since you loaded it", retryable: false });
      const text = bufs.length ? JSON.parse(Buffer.concat(bufs).toString("utf8")).text : "default";
      json(res, 200, { id: "orchestrator-rules", group: "Orchestrator", label: "Orchestrator rules", editable: true, text, source: req.method === "PUT" ? "override" : "default", etag: `${req.method}:${ifMatch}` });
    });
  }
  if (p === `/v1/wolves/${name}/threads` && req.method === "POST") {
    const bufs = [];
    req.on("data", (c) => bufs.push(c));
    req.on("end", () => json(res, 201, { served_by: name, echo: Buffer.concat(bufs).toString("utf8"), type: req.headers["content-type"] ?? null, auth: req.headers.authorization ?? null }));
    return;
  }
  if (p === `/v1/wolves/${name}/memory`) return json(res, 200, { served_by: name, query: url.search });
  if (p.startsWith(`/v1/wolves/${name}/memory/topics/`)) return json(res, 200, { served_by: name, topic: p.split("/").pop(), query: url.search });
  if (p.startsWith(`/v1/wolves/${name}/work/`) && p.endsWith("/record")) return json(res, 200, { served_by: name, work: p.split("/")[5] });
  if (p === `/v1/wolves/${name}/threads`) return json(res, 200, { threads: [{ id: `${name}/home`, wolf: name, kind: "home", title: "Home" }] });
  if (p === `/v1/threads/${name}%2Fhome` || p === `/v1/threads/${name}/home`)
    return json(res, 200, { served_by: name, version: req.headers["x-protocol-version"] ?? null, lastEventId: req.headers["last-event-id"] ?? null, method: req.method });
  if (p.endsWith("/stream") && p.includes("forever")) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("id: 1\ndata: hello\n\n");
    openStreams += 1;
    const t = setInterval(() => res.write("data: tick\n\n"), 50);
    res.on("close", () => (clearInterval(t), (openStreams -= 1)));
    return;
  }
  if (p.endsWith("/stream")) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(`id: 1\ndata: ${JSON.stringify({ lastEventId: req.headers["last-event-id"] ?? null })}\n\n`);
    let n = 1;
    const t = setInterval(() => {
      n += 1;
      res.write(`id: ${n}\ndata: frame-${n}\n\n`);
      if (n === 4) {
        res.write("data: [DONE]\n\n");
        clearInterval(t);
        res.end();
      }
    }, 150);
    res.on("close", () => clearInterval(t));
    return;
  }
  json(res, 404, { code: "not_found", message: "fake", retryable: false });
});

if (args.includes("--socket")) {
  const sock = arg("--socket");
  server.listen(sock, () => console.log(`wolfd: ${name} serving unix:${sock}`));
  process.on("SIGTERM", () => {
    try { unlinkSync(sock); } catch {}
    process.exit(0);
  });
} else {
  server.listen(Number(arg("--port") ?? 0), "127.0.0.1", () => {
    console.log(`wolfd: ${name} serving http://127.0.0.1:${server.address().port}`);
  });
  process.on("SIGTERM", () => process.exit(0));
}
