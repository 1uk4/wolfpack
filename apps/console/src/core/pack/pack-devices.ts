/**
 * Devices section rules (work-wolfpack-Rqmr32h). Pure.
 * In the Mac app alone (single-Mac mode) the list shows only this device, the app itself has no Revoke, and pairing is hidden.
 */
export const devicesToShow = <T extends { self: boolean }>(rows: readonly T[], singleMac: boolean): T[] => (singleMac ? rows.filter((r) => r.self) : [...rows]);
export const canRevoke = (singleMac: boolean): boolean => !singleMac;
export const canPair = (singleMac: boolean): boolean => !singleMac;
