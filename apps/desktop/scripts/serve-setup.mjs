/**
 * Dev only: serve the setup wizard page (electron/setup/) on a loopback port so it can be viewed in a browser.
 *   node apps/desktop/scripts/serve-setup.mjs --port 3240      then open http://127.0.0.1:3240/
 * Without the Electron bridge the page uses a stub: key "sk-ok" passes, any other is "That key didn't work",
 * and finishing logs the answers to the browser console. `?` is ignored; nothing is written anywhere.
 */
import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "electron", "setup");
const arg = process.argv.indexOf("--port");
const port = arg > 0 ? Number(process.argv[arg + 1]) : 3240;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port needs a port number");
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };

createServer((req, res) => {
	const path = new URL(req.url ?? "/", "http://x").pathname;
	const file = normalize(join(root, path === "/" ? "index.html" : path));
	if (!file.startsWith(root + sep) || !existsSync(file) || !types[extname(file)]) return void res.writeHead(404).end("not found");
	res.writeHead(200, { "content-type": types[extname(file)] });
	createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`setup wizard: http://127.0.0.1:${port}/`));
