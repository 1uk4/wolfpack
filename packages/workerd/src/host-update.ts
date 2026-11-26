/**
 * The host updater's state for the inventory (work-wolfpack-NqEVJAU): reads the status file scripts/auto-update.mjs writes
 * (WOLFPACK_AUTO_UPDATE_STATUS, default the sfo-01 path) and maps it with the same code the console uses for its own machine, so a remote
 * machine's card says what the local one says. A missing or unreadable file means "nothing to report".
 */
import { readFileSync } from "node:fs";
import type { HostStatusFile } from "@wolfpack/protocol/update-state";
import { worstHostUpdateState, type UpdateState } from "@wolfpack/protocol/update-state";

export const DEFAULT_AUTO_UPDATE_STATUS = "/var/lib/wolfpack-auto-update/status.json";

/** The status file path: WOLFPACK_AUTO_UPDATE_STATUS (the console reads the same variable), else the sfo-01 default. */
export const autoUpdateStatusFile = (env: NodeJS.ProcessEnv): string => env.WOLFPACK_AUTO_UPDATE_STATUS?.trim() || DEFAULT_AUTO_UPDATE_STATUS;

/** The failed or installing state of the host's updater, or undefined (quiet host, no file, unreadable file). Never throws. */
export function readHostUpdateState(file: string, channel: "stable" | "main" | null, now: number = Date.now()): UpdateState | undefined {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as HostStatusFile;
    if (!s || typeof s !== "object" || !s.units || typeof s.units !== "object") return undefined;
    return worstHostUpdateState(s, { now, channel });
  } catch {
    return undefined;
  }
}
