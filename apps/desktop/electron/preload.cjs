/*
 * Preload (2026-09-17, narrow-window wave): the ONLY bridge between the
 * sandboxed renderer and the main process. contextIsolation + sandbox are
 * on (electron/main.cjs), so this file is the renderer's entire access to
 * Electron — keep it a minimal, explicit API surface.
 *
 *   window.wolfpack.platform — read-only OS identity for native window-control
 *   gutters (darwin: left traffic lights; win32/linux: right overlay).
 *
 *   window.wolfpack.expandWindow() — widen the window to the sidebar auto-close
 *   threshold (928px) when the sidebar is opened below it. The main
 *   process clamps: no-op if the window is already wide enough.
 *
 *   window.wolfpack.onZoom(cb) / window.wolfpack.getZoom() — the zoom truth (owner
 *   round 7, 2026-10-05): every ⌘±/⌘0 change arrives as "wolfpack:zoom" with
 *   the new factor; getZoom covers the first-paint race. The renderer
 *   publishes it as --wp-zoom so physical-constant lengths (the traffic-
 *   light gutter) can divide by it.
 *
 *   window.wolfpack.onUpdateStatus(cb) / window.wolfpack.installUpdate() — the
 *   auto-update channel (Wave C, 2026-10-10): "wolfpack:update-status" pushes
 *   {status:"downloaded", version} once an update is staged; installUpdate
 *   asks main to kill the server and quit-and-install. Browser builds:
 *   both absent, the banner never renders.
 *
 *   window.wolfpack.notify({key,title,body,href}) / window.wolfpack.onNavigate(cb) —
 *   needs-you notifications (ticket 4): the renderer decides WHEN (a new
 *   pending card), main shows the OS notification only while the window is
 *   unfocused (once per key) and, on click, focuses the window and sends
 *   "wolfpack:navigate" with the thread's href back.
 *
 * Channel names are mirrored in electron/main.cjs — keep them in sync.
 */
const { contextBridge, ipcRenderer } = require("electron");

// main.cjs passes --wolfpack-single-mac when the app runs its own runtime (work-wolfpack-TdmbaV4): the console hides multi-machine UI.
const api = {
	platform: process.platform,
	singleMac: process.argv.includes("--wolfpack-single-mac"),
	expandWindow: () => ipcRenderer.send("wolfpack:expand-window"),
	onZoom: (cb) => {
		const listener = (_event, factor) => cb(factor);
		ipcRenderer.on("wolfpack:zoom", listener);
		return () => ipcRenderer.removeListener("wolfpack:zoom", listener);
	},
	getZoom: () => ipcRenderer.invoke("wolfpack:zoom:get"),
	onUpdateStatus: (cb) => {
		const listener = (_event, status) => cb(status);
		ipcRenderer.on("wolfpack:update-status", listener);
		return () => ipcRenderer.removeListener("wolfpack:update-status", listener);
	},
	installUpdate: () => ipcRenderer.send("wolfpack:update-install"),
	notify: (n) => ipcRenderer.send("wolfpack:notify", n),
	onNavigate: (cb) => {
		const listener = (_event, href) => cb(href);
		ipcRenderer.on("wolfpack:navigate", listener);
		return () => ipcRenderer.removeListener("wolfpack:navigate", listener);
	},
};

contextBridge.exposeInMainWorld("wolfpack", api);
