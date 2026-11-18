/**
 * When the app may run one KB curation window (work-wolfpack-F16FFQL). Pure: Electron (main.cjs) supplies the inputs.
 *
 *   idle      at least 10 minutes without keyboard or mouse (powerMonitor.getSystemIdleTime())
 *   spacing   at least 60 minutes since the last window started (this app run; a restart may curate once at once)
 *   battery   on battery power below 30%: no. On AC at any level: yes. On battery with an unreadable level: no.
 */
const IDLE_SECONDS = 600;
const MIN_GAP_MS = 60 * 60_000;
const MIN_BATTERY_PERCENT = 30;

function shouldCurate({ idleSeconds, onBattery, batteryPercent, lastRunAt, now }) {
	if (idleSeconds < IDLE_SECONDS) return false;
	if (lastRunAt != null && now - lastRunAt < MIN_GAP_MS) return false;
	if (onBattery && !(typeof batteryPercent === "number" && batteryPercent >= MIN_BATTERY_PERCENT)) return false;
	return true;
}

/** Battery percent from the InternalBattery line of `pmset -g batt` ("... 87%; discharging ..."), or null (desktop Mac, no such line). A UPS line is ignored. */
function parseBatteryPercent(pmsetOutput) {
	const line = String(pmsetOutput).split("\n").find((l) => l.includes("InternalBattery"));
	const m = line ? /(\d{1,3})%/.exec(line) : null;
	return m ? Math.min(100, Number(m[1])) : null;
}

module.exports = { shouldCurate, parseBatteryPercent, IDLE_SECONDS, MIN_GAP_MS, MIN_BATTERY_PERCENT };
