/**
 * The wake pump's waitForIdle polls until a dangling quiz is answered (correct in the product: the learner may take
 * as long as they like). A test that leaves one behind must not keep the node process alive: on 2026-11-09 that
 * hung tests/jobs.test.ts for 18 min at 0% CPU. The suite's shared reset has to stop those loops.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { PATHS } from "../config.ts";

const consoleDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("wake pipeline reset", () => {
	it("lets the process exit although a pump was parked behind a dangling quiz", () => {
		const run = spawnSync(process.execPath, ["--import", "tsx", "tests/fixtures/dangling-quiz.ts"], {
			cwd: consoleDir,
			env: { ...process.env, NODE_ENV: "test" },
			encoding: "utf8",
			timeout: 20_000,
			killSignal: "SIGKILL",
		});
		const id = /chat:(\S+)/.exec(run.stdout ?? "")?.[1];
		if (id) fs.rmSync(path.join(PATHS.chats, `${id}.json`), { force: true });
		assert.equal(run.error, undefined, `the process stayed alive past 20 s (waitForIdle loop): ${run.stderr}`);
		assert.equal(run.status, 0, run.stderr);
	});
});
