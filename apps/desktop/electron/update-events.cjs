"use strict";

/**
 * The Mac app's updater steps as plain JSON (work-wolfpack-5IZ3Xc9). Pure: no Electron.
 *
 * The shell is CJS inside the asar and must not import @wolfpack/protocol, so it forwards raw
 * AppUpdaterEvent-shaped objects ({type: "checking" | "available" | "not-available" | "progress" |
 * "downloaded" | "installing" | "error"}); the console maps them with mapAppEvent.
 * The downloaded event also carries the legacy `status: "downloaded"` the restart banner reads.
 */

const FOCUS_CHECK_AFTER_MS = 60 * 60 * 1000;

/** Subscribe to electron-updater's events; `send` gets each step. `last()` is the latest step, or null. */
function wireUpdater(updater, send, log = () => {}) {
	let last = null;
	let source = "user";
	const emit = (event) => {
		last = event;
		send(event);
	};
	updater.on("checking-for-update", () => emit({ type: "checking" }));
	updater.on("update-available", (info) => emit({ type: "available", version: info?.version ?? "" }));
	updater.on("update-not-available", (info) => emit({ type: "not-available", ...(info?.version ? { version: info.version } : {}) }));
	updater.on("download-progress", (p) => emit({ type: "progress", percent: Number(p?.percent) || 0 }));
	updater.on("update-downloaded", (info) => {
		log(`update downloaded: ${info?.version} — banner shown`);
		emit({ type: "downloaded", version: info?.version ?? "", status: "downloaded" });
	});
	updater.on("error", (err) => {
		log(`updater error: ${err?.message ?? err}`);
		// Quiet: a background check that failed before finding anything (offline laptop). A failed download or install is never quiet.
		const background = source === "background" && (last == null || last.type === "checking" || last.type === "error" || last.type === "not-available");
		emit({ type: "error", message: String(err?.message ?? err), ...(err?.code ? { code: String(err.code) } : {}), ...(background ? { background: true } : {}) });
	});
	return { last: () => last, record: emit, setSource: (s) => { source = s; } };
}

/** A window gained focus: check again only when the last check is over an hour old (or there was none). */
function shouldCheckOnFocus(lastAt, now) {
	return lastAt == null || now - lastAt > FOCUS_CHECK_AFTER_MS;
}

/** Run a check with an in-flight flag that is always released, even when `run` throws synchronously or returns a non-promise. */
function guardedCheck(guard, run) {
	guard.busy = true;
	return Promise.resolve()
		.then(run)
		.finally(() => {
			guard.busy = false;
		});
}

/** An update IPC call is allowed only from the main frame of a page on the console origin the window loaded (local or remote). */
function fromAppOrigin(e, origin) {
	try {
		if (!e?.senderFrame || !e.sender || e.senderFrame !== e.sender.mainFrame) return false;
		return new URL(e.senderFrame.url).origin === new URL(origin).origin;
	} catch {
		return false;
	}
}

/** Restart-and-install only makes sense once the update has finished downloading. */
function canInstall(last) {
	return last?.type === "downloaded";
}

module.exports = { wireUpdater, shouldCheckOnFocus, guardedCheck, fromAppOrigin, canInstall };
