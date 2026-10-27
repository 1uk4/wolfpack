/*
 * Needs-you notifications (ticket 4), the guard logic kept free of `require("electron")` so tests can drive it with
 * fakes. The renderer decides WHEN a card is new; this module only validates and delivers:
 *   - the IPC sender must be the app window's MAIN frame (a subframe or another window cannot raise notifications);
 *   - the window must be unfocused (the operator is not looking at it);
 *   - once per key (bounded set);
 *   - the href must resolve to the app's own origin (rejects "https://evil", "//evil", "/\evil.com", "javascript:").
 * Clicking restores + focuses the window and sends the normalized path back ("lh:navigate").
 */

const NOTIFIED_MAX = 200;

/** The in-app path (pathname+search+hash) for `href`, or null when it does not stay on `appOrigin`. */
function safeNotifyHref(href, appOrigin) {
	if (typeof href !== "string" || href.length > 2048 || !href.startsWith("/")) return null;
	let u;
	try {
		u = new URL(href, appOrigin);
	} catch {
		return null;
	}
	return u.origin === appOrigin ? `${u.pathname}${u.search}${u.hash}` : null;
}

/** True when the IPC event came from `win`'s main frame. */
function isMainFrameSender(event, win) {
	return Boolean(win && !win.isDestroyed() && event && event.senderFrame && event.senderFrame === win.webContents.mainFrame);
}

function createNeedsYouNotifier({ Notification, appOrigin }) {
	const notified = new Set();
	return function handle(event, win, n) {
		if (!isMainFrameSender(event, win) || win.isFocused()) return false;
		if (!n || typeof n.key !== "string" || typeof n.title !== "string" || typeof n.body !== "string") return false;
		const href = safeNotifyHref(n.href, appOrigin);
		if (href === null) return false;
		if (!Notification.isSupported() || notified.has(n.key)) return false;
		notified.add(n.key);
		if (notified.size > NOTIFIED_MAX) notified.delete(notified.values().next().value);
		const note = new Notification({ title: n.title.slice(0, 120), body: n.body.slice(0, 300) });
		note.on("click", () => {
			if (win.isDestroyed()) return;
			if (win.isMinimized()) win.restore();
			win.show();
			win.focus();
			win.webContents.send("lh:navigate", href);
		});
		note.show();
		return true;
	};
}

module.exports = { safeNotifyHref, isMainFrameSender, createNeedsYouNotifier };
