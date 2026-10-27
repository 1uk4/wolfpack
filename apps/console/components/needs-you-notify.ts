import type { NeedsYouNotification } from "@/src/core";

/**
 * Delivering a needs-you notification (the decision — which cards, when — is the pure planNotifications in the core).
 *
 * Electron: the renderer hands the notification to the main process (window.lh.notify), which shows the OS
 * notification only while the window is unfocused and focuses the window + sends the click's href back (window.lh.onNavigate).
 * Plain browser: the Web Notifications API, behind an opt-in toggle (localStorage) AND the browser's granted permission;
 * without both, nothing fires. A click focuses the tab and navigates.
 */

export const NOTIFY_PREF_KEY = "lh:notify-needs-you";

const webSupported = (): boolean => typeof window !== "undefined" && typeof Notification !== "undefined";

/** True inside the Electron shell (its preload exposes `notify`). */
export const isDesktopNotify = (): boolean => typeof window !== "undefined" && typeof window.lh?.notify === "function";

/** The toggle is only offered in a browser that can show notifications. */
export const canToggleBrowserNotify = (): boolean => !isDesktopNotify() && webSupported();

/** The browser toggle's state: unsupported (hidden), off, on, or blocked by the browser's permission. */
export type BrowserNotifyState = "unsupported" | "off" | "on" | "denied";

export function browserNotifyState(): BrowserNotifyState {
	if (!canToggleBrowserNotify()) return "unsupported";
	if (Notification.permission === "denied") return "denied";
	return browserNotifyEnabled() ? "on" : "off";
}

export function browserNotifyEnabled(): boolean {
	if (!webSupported()) return false;
	try {
		return localStorage.getItem(NOTIFY_PREF_KEY) === "1" && Notification.permission === "granted";
	} catch {
		return false;
	}
}

/** Turn the toggle on (asks for permission) or off. Resolves to the resulting state. */
export async function setBrowserNotify(on: boolean): Promise<boolean> {
	if (!webSupported()) return false;
	if (!on) {
		try {
			localStorage.removeItem(NOTIFY_PREF_KEY);
		} catch {
			/* private mode */
		}
		return false;
	}
	const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
	if (permission !== "granted") return false;
	try {
		localStorage.setItem(NOTIFY_PREF_KEY, "1");
	} catch {
		return false;
	}
	return true;
}

/** Show one notification. `navigate` opens the thread when a browser notification is clicked. */
export function deliverNotification(n: NeedsYouNotification, navigate: (href: string) => void): void {
	if (isDesktopNotify()) {
		window.lh!.notify!({ key: n.key, title: n.title, body: n.body, href: n.href });
		return;
	}
	if (!browserNotifyEnabled()) return;
	const note = new Notification(n.title, { body: n.body, tag: n.key });
	note.onclick = () => {
		window.focus();
		navigate(n.href);
	};
}
