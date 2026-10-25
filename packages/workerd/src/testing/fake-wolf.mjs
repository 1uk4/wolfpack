// Fake wolfd for workerd tests: `node fake-wolf.mjs --config <wolf.yaml> --port N`. No engine, no model.
import { createServer } from "node:http";
import { readFileSync, unlinkSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (k) => args[args.indexOf(k) + 1];
const name = /^name:\s*(\S+)/m.exec(readFileSync(arg("--config"), "utf8"))[1];
if (process.env.FAKE_EXIT_IMMEDIATELY) process.exit(3);

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  if (p === "/crash") process.exit(1);
  if (p === "/v1/wolves") return json(res, 200, { wolves: [{ id: name, name, host: "fake", status: process.env.FAKE_STATUS ?? "online" }] });
  if (p === `/v1/wolves/${name}/threads`) return json(res, 200, { threads: [{ id: `${name}/home`, wolf: name, kind: "home", title: "Home" }] });
  if (p === `/v1/threads/${name}%2Fhome` || p === `/v1/threads/${name}/home`)
    return json(res, 200, { served_by: name, version: req.headers["x-protocol-version"] ?? null, lastEventId: req.headers["last-event-id"] ?? null, method: req.method });
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
