#!/usr/bin/env node
/**
 * Stamp the desktop app's own version (apps/desktop/package.json) as the VERSION of every bundled component
 * (work-wolfpack-SzoWaBZ). hubd, workerd, wolfd and the console are one build in the app, so they all report the app version
 * instead of "unknown" / "<pkg>-dev". Each service reads a VERSION file next to its entry (protocol stampedVersion):
 *   <runtime>/VERSION            hubd.mjs, workerd.mjs      (./VERSION)
 *   <runtime>/wolfd/VERSION      wolfd/wolfd.mjs            (./VERSION via the bundle's own folder)
 *   <payload>/VERSION            the console server payload (<payload>/apps/console/server.js chdirs there; stamp two levels up)
 *   <payload>/apps/console/VERSION  the console's cwd stamp
 *   node apps/desktop/scripts/stamp-version.mjs [runtime-dir] [console-payload-dir]
 * The payload is optional: with only a runtime dir, only the runtime stamps are written.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const here = import.meta.dirname;
const version = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version;
const runtime = path.resolve(process.argv[2] ?? path.join(here, "..", "runtime"));
const payload = process.argv[3] ? path.resolve(process.argv[3]) : undefined;

const targets = [path.join(runtime, "VERSION"), path.join(runtime, "wolfd", "VERSION")];
if (payload) targets.push(path.join(payload, "VERSION"), path.join(payload, "apps", "console", "VERSION"));
for (const t of targets) {
	fs.mkdirSync(path.dirname(t), { recursive: true });
	fs.writeFileSync(t, `${version}\n`);
	console.log(`[stamp-version] ${t} = ${version}`);
}
