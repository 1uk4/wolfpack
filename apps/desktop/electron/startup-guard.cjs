"use strict";
// Startup guard (work-wolfpack-SzoWaBZ). A relaunch right after a SIGTERM quit once came up holding the single-instance
// lock with no window, no log line and Electron's `ready` never firing: a silent process the user cannot tell from a
// crash. If `ready` does not arrive in time, say so in the log and exit, so the next launch starts clean.

function readyWatchdog({ whenReady, ms, log, exit, setTimer = setTimeout, clearTimer = clearTimeout }) {
	let done = false;
	const timer = setTimer(() => {
		if (done) return;
		done = true;
		log(`startup: Electron never became ready within ${Math.round(ms / 1000)}s; exiting so the next launch starts clean`);
		exit(1);
	}, ms);
	whenReady.then(() => {
		done = true;
		clearTimer(timer);
	});
}

module.exports = { readyWatchdog };
