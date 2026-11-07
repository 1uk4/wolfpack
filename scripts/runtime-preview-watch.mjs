#!/usr/bin/env node
/**
 * Background backend rebuild for a worktree preview, run by launchd as com.wolfpack.preview-watch:
 * `tsc --build --watch` on the worktree's root project. Every line is logged with a time; each finished rebuild without errors
 * (not the first completion, which is the baseline whether or not it had errors) records {lastRebuildOk} in the watch file, which `wolfpack preview
 * status` compares with the stack's start time. Usage: node runtime-preview-watch.mjs <worktree> <watchFile> <logFile>
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const [wt, watchFile, logFile] = process.argv.slice(2);
const tsc = path.join(wt, "node_modules", "typescript", "bin", "tsc");
const child = spawn(process.execPath, [tsc, "--build", "--watch", "--preserveWatchOutput"], { cwd: wt, stdio: ["ignore", "pipe", "pipe"] });
let first = true;
const onLine = (line) => {
	fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
	const m = /Found (\d+) errors?/.exec(line);
	if (!m) return;
	if (first) first = false; // the first completed build is the baseline, errors or not
	else if (m[1] === "0") fs.writeFileSync(watchFile, `${JSON.stringify({ lastRebuildOk: new Date().toISOString() })}\n`);
};
for (const stream of [child.stdout, child.stderr]) readline.createInterface({ input: stream }).on("line", onLine);
child.on("close", (code) => process.exit(code ?? 1)); // after the output is read
