/**
 * Menu-bar (tray) item for the app runtime: Open Wolfpack, wolf status, Open at login, Quit.
 *
 * `windowAllClosedAction` is the pure decision behind "closing the window is never Quit":
 * in app runtime the last window closing hides the app (services keep running); only Quit stops them.
 * Everything else here is Electron wiring and is checked by hand (see the ticket's manual check).
 */
const path = require("node:path");

/** What to do when the last window closes: "hide" (app runtime: keep wolves running, drop the Dock icon), "quit" (non-mac, other modes), "stay" (mac, other modes: today's behaviour). */
function windowAllClosedAction({ appRuntime, platform }) {
	if (appRuntime) return "hide";
	return platform === "darwin" ? "stay" : "quit";
}

/** The Open-at-login state, shared by the tray checkbox and the console Settings switch: { openAtLogin, needsApproval }. */
function loginItemState(app) {
	const login = app.getLoginItemSettings();
	return { openAtLogin: !!login.openAtLogin, needsApproval: login.status === "requires-approval" };
}

/** Turn Open at login on or off. macOS ignores `args` here (SMAppService); a login start is detected by main.cjs via wasOpenedAtLogin. Returns the state read back, plus `error` if the call threw. */
function setLoginItem(app, on, log) {
	let error;
	try {
		app.setLoginItemSettings({ openAtLogin: !!on });
		log?.(`open at login: ${on ? "on" : "off"}`);
	} catch (err) {
		error = String(err?.message ?? err);
		log?.(`open at login failed: ${error}`);
	}
	return { ...loginItemState(app), ...(error ? { error } : {}) };
}

/** Creates the tray. `getStatus()` -> { running }, `openWindow()`, `quit()`. Returns { refresh, destroy }: call refresh() on status changes; the menu is rebuilt only when running or openAtLogin changed. */
function createTray({ app, Tray, Menu, nativeImage, getStatus, openWindow, quit, log }) {
	const icon = nativeImage.createFromPath(path.join(__dirname, "tray", "trayTemplate.png"));
	icon.setTemplateImage(true);
	const tray = new Tray(icon);
	tray.setToolTip("Wolfpack");
	let shown = "";

	function refresh() {
		const running = getStatus().running;
		const login = loginItemState(app);
		const needsApproval = login.needsApproval;
		const key = JSON.stringify([running, login.openAtLogin, needsApproval]);
		if (key === shown) return;
		shown = key;
		tray.setContextMenu(
			Menu.buildFromTemplate([
				{ label: "Open Wolfpack", click: openWindow },
				{ label: running ? "Wolf: running" : "Wolf: stopped", enabled: false },
				{ type: "separator" },
				{
					label: needsApproval ? "Open at login (needs approval in System Settings)" : "Open at login",
					type: "checkbox",
					checked: login.openAtLogin,
					click: (item) => {
						setLoginItem(app, item.checked, log);
						shown = ""; // always rebuild: the checkbox may have flipped without the setting taking
						refresh();
					},
				},
				{ type: "separator" },
				{ label: "Quit Wolfpack", click: quit },
			]),
		);
	}

	refresh();
	// A change made in System Settings shows up when the menu-bar item is clicked.
	tray.on("click", () => refresh());
	return { refresh, destroy: () => tray.destroy() };
}

module.exports = { windowAllClosedAction, createTray, loginItemState, setLoginItem };
