/** Platform window chrome + packaging policy, without launching Electron. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const mainFile = fileURLToPath(new URL("../../desktop/electron/main.cjs", import.meta.url));
const mainSource = readFileSync(mainFile, "utf8");

/** Decline the single-instance lock so normal boot never spawns a server.
 * Then call the REAL createWindow with a stub Electron API and inspect its
 * constructor options. No rewritten copy of the production logic. */
function windowOptions(platform: string) {
	class FakeWindow {
		constructor(readonly options: unknown) {}
		webContents = { on() {}, setWindowOpenHandler() {} };
		loadURL() {}
		once() {}
	}
	const electron = {
		app: { setName() {}, getPath: () => "/nonexistent/wolfpack-test-userdata", requestSingleInstanceLock: () => false, quit() {} },
		BrowserWindow: FakeWindow,
		session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
	};
	const context = {
		require: (id: string) =>
			id === "electron" ? electron : id === "./notify.cjs" ? require("../../desktop/electron/notify.cjs") : id === "./remote.cjs" ? require("../../desktop/electron/remote.cjs") : id === "./userdata-migrate.cjs" ? require("../../desktop/electron/userdata-migrate.cjs") : require(id),
		process: { platform, argv: [], env: {}, on() {} },
		__dirname: dirname(mainFile),
	};
	runInNewContext(mainSource, context, { filename: mainFile });
	const win = runInNewContext('createWindow("http://127.0.0.1:9000")', context) as FakeWindow;
	// The options originate in a VM realm; normalize prototypes for assertions.
	return JSON.parse(JSON.stringify(win.options));
}

describe("desktop window chrome", () => {
	it("macOS keeps the proven traffic lights and does not enable WCO", () => {
		const options = windowOptions("darwin");
		assert.equal(options.titleBarStyle, "hiddenInset");
		assert.deepEqual(options.trafficLightPosition, { x: 16, y: 22.5 });
		assert.equal(options.titleBarOverlay, undefined);
		assert.equal(options.autoHideMenuBar, undefined);
	});

	for (const platform of ["win32", "linux"]) {
		it(`${platform} uses native-height right-side controls with an Alt-accessible menu`, () => {
			const options = windowOptions(platform);
			assert.equal(options.titleBarStyle, "hidden");
			assert.deepEqual(options.titleBarOverlay, { color: "#141414", symbolColor: "#e5e5e5" });
			assert.equal(Object.hasOwn(options.titleBarOverlay, "height"), false, "omit height so the OS selects its native default");
			assert.equal(options.trafficLightPosition, undefined);
			assert.equal(options.autoHideMenuBar, true);
			assert.equal(options.webPreferences.contextIsolation, true);
			assert.equal(options.webPreferences.sandbox, true);
			assert.equal(options.webPreferences.nodeIntegration, false);
		});
	}

	it("preload exposes OS identity without exposing Node/Electron to the renderer", () => {
		const exposed = new Map<string, Record<string, unknown>>();
		const context = {
			process: { platform: "win32" },
			require: () => ({
				contextBridge: {
					exposeInMainWorld(name: string, api: Record<string, unknown>) {
						exposed.set(name, api);
					},
				},
				ipcRenderer: {},
			}),
		};
		runInNewContext(readFileSync(new URL("../../desktop/electron/preload.cjs", import.meta.url), "utf8"), context);
		assert.deepEqual([...exposed.keys()], ["wolfpack"]);
		const bridge = exposed.get("wolfpack") as Record<string, unknown>;
		assert.equal(bridge.platform, "win32");
		assert.deepEqual(Object.keys(bridge).sort(), [
			"expandWindow", "getZoom", "installUpdate", "notify", "onNavigate", "onUpdateStatus", "onZoom", "platform",
		]);
	});
});

describe("desktop packaging policy", () => {
	const yaml = require("js-yaml") as { load(source: string): Record<string, any> };
	const config = yaml.load(readFileSync(new URL("../../desktop/electron-builder.yml", import.meta.url), "utf8"));

	it("configuration is accepted by the INSTALLED electron-builder schema", async () => {
		// electron-builder lives in the desktop workspace's dependency tree.
		const desktopRequire = createRequire(fileURLToPath(new URL("../../desktop/package.json", import.meta.url)));
		const { validateConfiguration } = desktopRequire("app-builder-lib/out/util/config/config.js");
		await validateConfiguration(config, { isEnabled: false });
	});

	it("ships Mac arm64, Windows NSIS x64, and both Linux x64 channels", () => {
		assert.deepEqual(config.mac.target, [
			{ target: "dmg", arch: ["arm64"] }, { target: "zip", arch: ["arm64"] },
		]);
		assert.deepEqual(config.win.target, [{ target: "nsis", arch: ["x64"] }]);
		assert.equal(config.win.signExecutable, false);
		assert.equal(config.win.verifyUpdateCodeSignature, false);
		assert.deepEqual(config.linux.target, [
			{ target: "AppImage", arch: ["x64"] }, { target: "deb", arch: ["x64"] },
		]);
		assert.equal(config.linux.syncDesktopName, true);
		assert.equal(config.publish[0].releaseType, "draft");
	});

	it("deb has public maintainer metadata and a matching desktop identity", () => {
		const pkg = JSON.parse(readFileSync(new URL("../../desktop/package.json", import.meta.url), "utf8"));
		// author shape the deb target needs: name + email (value set by the provenance branch).
		assert.equal(pkg.author.name, "Luka Flores");
		assert.match(pkg.author.email, /^[^@\s]+@[^@\s]+$/);
		assert.equal(pkg.homepage, "https://github.com/1uk4/wolfpack");
		assert.equal(pkg.desktopName, "wolfpack-console.desktop");
	});
});
