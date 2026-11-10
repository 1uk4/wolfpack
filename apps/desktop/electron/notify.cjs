/*
 * Needs-you notifications (ticket 4), the guard logic kept free of `require("electron")` so tests can drive it with
 * fakes. The renderer decides WHEN a card is new; this module only validates and delivers:
 *   - the IPC sender must be the app window's MAIN frame (a subframe or another window cannot raise notifications);
 *   - the window must be unfocused (the operator is not looking at it);
 *   - once per key (bounded set);
 *   - the href must resolve to the app's own origin (rejects "https://evil", "//evil", "/\evil.com", "javascript:").
 * Clicking restores + focuses the window and sends the normalized path back ("wolfpack:navigate").
 */

const NOTIFIED_MAX = 200;
// `always` notifications (replies) skip the focus gate, so they are rate limited per window: at most this many per window of time.
const ALWAYS_MAX = 6;
const ALWAYS_WINDOW_MS = 60000;

/** The in-app path (pathname+search+hash) for `href`, or null when it does not stay on `appOrigin`. */
function safeNotifyHref(href, appOrigin) {
	if (typeof href !== "string" || href.length > 2048 || !href.startsWith("/")) return null;
	let u;
	try {
		u = new URL(href, appOrigin);
	} catch {
		return null;
	}
	const path = `${u.pathname}${u.search}${u.hash}`;
	// "/.//evil.com" normalizes on the same origin but would navigate protocol-relative once re-resolved.
	return u.origin === appOrigin && !path.startsWith("//") ? path : null;
}

/** True when the IPC event came from `win`'s main frame. */
function isMainFrameSender(event, win) {
	return Boolean(win && !win.isDestroyed() && event && event.senderFrame && event.senderFrame === win.webContents.mainFrame);
}

function createNeedsYouNotifier({ Notification, appOrigin, log = () => {}, now = Date.now }) {
	const notified = new Set();
	let alwaysTimes = [];
	return function handle(event, win, n) {
		const key = n && typeof n.key === "string" ? n.key.slice(0, 80).replace(/\s+/g, " ") : "?";
		log(`notify: received key=${key}`);
		const reject = (why) => {
			log(`notify: rejected key=${key} (${why})`);
			return false;
		};
		if (!isMainFrameSender(event, win)) return reject("not main frame");
		// `always`: a reply notification; the renderer already decided the owner is not looking at that thread.
		if (win.isFocused() && !(n && n.always === true)) return reject("window focused");
		if (!n || typeof n.key !== "string" || typeof n.title !== "string" || typeof n.body !== "string") return reject("malformed payload");
		const href = safeNotifyHref(n.href, appOrigin);
		if (href === null) return reject("bad href");
		if (!Notification.isSupported()) return reject("notifications unsupported");
		if (notified.has(n.key)) return reject("duplicate");
		if (n.always === true) {
			const t = now();
			alwaysTimes = alwaysTimes.filter((x) => t - x < ALWAYS_WINDOW_MS);
			// A throttled reply is lost for good, by design: it is not queued or retried (a burst of replies must not flood the OS).
			if (alwaysTimes.length >= ALWAYS_MAX) return reject("rate limited");
			alwaysTimes.push(t);
		}
		notified.add(n.key);
		if (notified.size > NOTIFIED_MAX) notified.delete(notified.values().next().value);
		const note = new Notification({ title: n.title.slice(0, 120), body: n.body.slice(0, 300) });
		note.on("click", () => {
			log(`notify: clicked key=${key}`);
			if (win.isDestroyed()) return;
			if (win.isMinimized()) win.restore();
			win.show();
			win.focus();
			win.webContents.send("wolfpack:navigate", href);
		});
		// Electron reports an OS-level refusal (e.g. no Notification Center permission) here, when it reports it at all.
		note.on("failed", (_e, error) => log(`notify: failed key=${key} (${error})`));
		note.show();
		log(`notify: shown key=${key}`);
		return true;
	};
}

module.exports = { safeNotifyHref, isMainFrameSender, createNeedsYouNotifier };
